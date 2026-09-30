-- supabase/migrations/0030_refunds.sql
--
-- Refunds, part 2 of 3: the link, its shape, and the rules a foreign key
-- cannot express. See the spec §2 for the decisions; the comments here only
-- say why each piece has the form it has.

alter table public.transactions add column refund_of uuid;

-- The composite FK below needs a unique target.
alter table public.transactions
  add constraint transactions_id_space_unique unique (id, space_id);

-- Same-household by construction: the refund's space_id must equal the
-- expense's. Deferrable initially immediate like the *_same_space keys in
-- 0025, because leave_space_impl defers them all and moves categorised rows
-- (the expense) before uncategorised ones (its refund); a non-deferrable key
-- would fail between the two statements. A deferrable key cannot be
-- RESTRICT, so this is NO ACTION: checked at statement end, which also lets
-- an account deletion that cascades through both the expense and its refund
-- in ONE statement through, while still refusing a deletion that would leave
-- a refund behind.
alter table public.transactions
  add constraint transactions_refund_same_space
    foreign key (refund_of, space_id) references public.transactions (id, space_id)
      deferrable initially immediate,
  add constraint refund_shape check (
    kind <> 'refund'
    or (refund_of is not null and category_id is null and amount_minor > 0
        and transfer_id is null and recurring_id is null)),
  add constraint non_refund_no_link check (kind = 'refund' or refund_of is null);

create index transactions_refund_of on public.transactions (refund_of) where refund_of is not null;

-- recurring_rules.kind is txn_kind too; a rule never describes a refund.
alter table public.recurring_rules
  add constraint rule_kind_not_refund check (kind <> 'refund');

-- Refund side. Fires on insert and whenever a refund's link, currency or
-- deletion state changes (restore included). The membership test uses the
-- SAME message as "not an expense" so it cannot be used to probe other
-- wallets, and is skipped when auth.uid() is null (service scripts, tests).
create function public.check_refund_parent() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  p record;
begin
  -- A missing refund_of returns here so refund_shape (a CHECK, which runs
  -- after BEFORE triggers) reports it, rather than this trigger's message.
  if new.kind <> 'refund' or new.deleted_at is not null or new.refund_of is null then
    return new;
  end if;

  select t.kind, t.deleted_at, t.currency_code, t.wallet_id into p
    from public.transactions t
   where t.id = new.refund_of;

  if not found or p.kind <> 'expense'
     or (auth.uid() is not null and not public.is_wallet_member(p.wallet_id)) then
    raise exception 'a repayment must repay an expense';
  end if;
  if p.deleted_at is not null then
    raise exception 'the repaid expense was deleted';
  end if;
  if p.currency_code <> new.currency_code then
    raise exception 'a repayment must be in the expense''s currency';
  end if;
  return new;
end $$;

create trigger transactions_check_refund_parent
  before insert or update of refund_of, currency_code, deleted_at on public.transactions
  for each row execute function public.check_refund_parent();

-- Expense side. security definer so the EXISTS sees refunds in wallets the
-- caller cannot: a repayment someone else recorded still pins the expense.
-- `kind` and `currency_code` are both in 0004's UPDATE grant, so without
-- this a direct PATCH could turn a repaid expense into income.
create function public.guard_refunded_expense() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if old.kind = 'expense'
     and ((old.deleted_at is null and new.deleted_at is not null)
          or new.kind is distinct from old.kind
          or new.currency_code is distinct from old.currency_code)
     and exists (select 1 from public.transactions r
                  where r.refund_of = old.id and r.deleted_at is null) then
    raise exception 'this expense has repayments';
  end if;
  return new;
end $$;

create trigger transactions_guard_refunded_expense
  before update of deleted_at, kind, currency_code on public.transactions
  for each row execute function public.guard_refunded_expense();

-- PostgREST computed relationship: `repaid_expense(...)` in a select embeds
-- the expense a refund repays. SECURITY INVOKER (the default), so the
-- caller's RLS applies: an expense in a wallet they cannot see embeds as
-- null. A plain self-FK embed is ambiguous in PostgREST (the same FK names
-- both directions), which is why this is a function.
create function public.repaid_expense(public.transactions)
  returns setof public.transactions rows 1
  language sql stable as $$
  select * from public.transactions where id = $1.refund_of
$$;

-- PostgREST computed field: the category a row counts under. An expense's
-- own; a refund's expense's. Lets /transactions filter one category and get
-- its expenses and their repayments together.
create function public.effective_category_id(public.transactions)
  returns uuid
  language sql stable as $$
  select coalesce($1.category_id,
                  (select p.category_id from public.transactions p where p.id = $1.refund_of))
$$;
