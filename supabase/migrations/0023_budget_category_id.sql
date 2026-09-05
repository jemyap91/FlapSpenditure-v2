-- supabase/migrations/0023_budget_category_id.sql
--
-- budgets.category_key becomes a real foreign key again (design 2026-09-05
-- §6). 0013 keyed a budget to a category NAME -- `lower(btrim(name))`,
-- guarded by a CHECK -- for one reason only: categories were wallet-scoped
-- (0008) and a budget spanning several wallets had no single category row
-- to point at. That was a foreign key downgraded to a string join. 0022
-- gave every household one category list, so the row exists again, and
-- this migration points at it.
--
-- Deliberately a SEPARATE transaction from 0022 (its own header says why):
-- 0022 lands in a coherent state on its own, with budgets still working by
-- name, so a failure here rolls back to something that runs rather than to
-- something half-converted.
--
-- Both functions are dropped EXPLICITLY, per 0013's own hard-won note: a
-- PL/pgSQL body is opaque to Postgres dependency tracking, so dropping a
-- column a function reads leaves the function present and broken at
-- runtime rather than gone. get_budget_status keeps its signature but its
-- RETURN columns change, which `create or replace` refuses; set_budget's
-- first parameter changes type, which would otherwise leave the old
-- overload alive beside the new one.

drop function get_budget_status(date, date);
drop function set_budget(text, date, bigint, uuid[]);

-- ─────────────────────────────────────────────────────────────────────────
-- A. A budget belongs to a household
-- ─────────────────────────────────────────────────────────────────────────
-- Derived from its wallet set, which set_budget already requires the
-- caller to be a member of every wallet in. Every wallet a user can be a
-- member of is in a household they are a member of (0022's
-- wallet_members_in_space), and 0022 built spaces as connected components
-- of the sharing graph, so a budget's wallets provably share one space.
-- The guard below asserts that anyway rather than trusting the argument.

alter table budgets add column space_id uuid references spaces(id) on delete cascade;

update budgets b
   set space_id = sub.space_id
  from (
    select bw.budget_id, min(w.space_id::text)::uuid as space_id, count(distinct w.space_id) as n
      from budget_wallets bw
      join wallets w on w.id = bw.wallet_id
     group by bw.budget_id
  ) sub
 where sub.budget_id = b.id;

do $$
declare v int;
begin
  select count(*) into v
    from (select bw.budget_id, count(distinct w.space_id) as n
            from budget_wallets bw join wallets w on w.id = bw.wallet_id
           group by bw.budget_id) s
   where s.n > 1;
  if v > 0 then
    raise exception '0023: % budget(s) span more than one household', v;
  end if;
end $$;

-- A budget with no wallets has no household to derive, and has been
-- unreachable since 0013 closed its HAZARD: budget_visible fails closed on
-- an empty set, so nobody -- not even its creator -- can read, edit or
-- delete it, and no path creates one any more (set_budget refuses an empty
-- set; direct INSERT is revoked). These are dead rows, and NOT NULL below
-- cannot hold with them present. Removed, and counted aloud.
do $$
declare v int;
begin
  delete from budgets where space_id is null;
  get diagnostics v = row_count;
  if v > 0 then
    raise notice '0023: removed % wallet-less budget(s) that nothing could reach', v;
  end if;
end $$;

alter table budgets alter column space_id set not null;
alter table budgets add constraint budgets_id_space_unique unique (id, space_id);

-- ─────────────────────────────────────────────────────────────────────────
-- B. category_key -> category_id
-- ─────────────────────────────────────────────────────────────────────────
-- Matched exactly the way get_budget_status matched at read time --
-- lower(btrim(name)) within the budget's household -- so every budget keeps
-- reporting against the same category it did yesterday. An ACTIVE category
-- wins over an archived one of the same name (only active rows are unique
-- per name; an archived duplicate may exist beside a live one), and the
-- oldest breaks any remaining tie, mirroring 0022's merge rule.

alter table budgets add column category_id uuid;

update budgets b
   set category_id = c.id
  from (
    select distinct on (space_id, key) id, space_id, key
      from (select id, space_id, lower(btrim(name)) as key, archived_at, created_at
              from categories where kind = 'expense') x
     order by space_id, key, (archived_at is null) desc, created_at asc
  ) c
 where c.space_id = b.space_id
   and b.category_key is not null
   and c.key = b.category_key;

-- A key that matches nothing. The design said "keep NULL and report", but
-- NULL now MEANS the household's overall cap, so a budget over a vanished
-- category would silently become a cap on all spending -- a real semantic
-- change. What it was yesterday: a row labelled by its key, matching no
-- transactions, reporting zero. That is exactly what an ARCHIVED category of
-- that name gives it today (archived rows are excluded from pickers but
-- still resolve a label), so one is minted per unmatched key, and each is
-- reported. The name is the key verbatim -- the only spelling that survives
-- -- truncated to the column's 40-character limit.
do $$
declare r record; v_cat uuid; n int := 0;
begin
  for r in
    select distinct b.space_id, b.category_key
      from budgets b
     where b.category_key is not null and b.category_id is null
  loop
    insert into categories (space_id, name, kind, color_slot, icon, sort_order, is_default, archived_at)
    values (r.space_id, left(r.category_key, 40), 'expense', 12, 'circle-ellipsis', 999, false, now())
    returning id into v_cat;
    update budgets set category_id = v_cat
     where space_id = r.space_id and category_key = r.category_key and category_id is null;
    n := n + 1;
    raise notice '0023: budget key % in space % matched no category; an archived placeholder was created',
      r.category_key, r.space_id;
  end loop;
  if n > 0 then
    raise notice '0023: % unmatched budget key(s) resolved to archived placeholder categories', n;
  end if;
end $$;

do $$
declare v int;
begin
  select count(*) into v from budgets where category_key is not null and category_id is null;
  if v > 0 then
    raise exception '0023: % budget(s) still have a key but no category', v;
  end if;
end $$;

alter table budgets drop column category_key;

-- A budget's category must live in the budget's own household. Same
-- composite-FK idiom as transactions_category_same_space (0022); MATCH
-- SIMPLE skips the overall cap (category_id null). ON DELETE RESTRICT,
-- matching transactions and recurring_rules: a category with a budget on it
-- is archived, never deleted.
alter table budgets
  add constraint budgets_category_same_space
    foreign key (category_id, space_id) references categories (id, space_id) on delete restrict;

-- ─────────────────────────────────────────────────────────────────────────
-- C. budget_wallets cannot span households either
-- ─────────────────────────────────────────────────────────────────────────

alter table budget_wallets add column space_id uuid;
update budget_wallets bw set space_id = w.space_id from wallets w where w.id = bw.wallet_id;
alter table budget_wallets alter column space_id set not null;

alter table budget_wallets
  add constraint budget_wallets_wallet_same_space
    foreign key (wallet_id, space_id) references wallets (id, space_id) on delete cascade,
  add constraint budget_wallets_budget_same_space
    foreign key (budget_id, space_id) references budgets (id, space_id) on delete cascade;

-- set_row_space (0022) derives space_id from new.wallet_id when it arrives
-- NULL, and budget_wallets has a wallet_id -- the same trigger serves.
-- set_budget supplies the value explicitly; this is for fixtures and for
-- any future caller with no reason to know households exist.
create trigger budget_wallets_set_space before insert on budget_wallets
  for each row execute function set_row_space();

-- Grants need no change: budgets' UPDATE is column-scoped to amount_minor
-- (0013), so neither new column is writable; INSERT is revoked on both
-- tables, so set_budget stays the only writer; SELECT is table-wide, so a
-- member reads category_id and space_id like every other column.

-- ─────────────────────────────────────────────────────────────────────────
-- D. get_budget_status, on ids
-- ─────────────────────────────────────────────────────────────────────────
-- Same shape as 0013's, with three changes: `category_id` replaces
-- `category_key` in the output; spending matches `t.category_id =
-- e.category_id` rather than a name join; and the label is the category's
-- own name via its id, so a rename shows up on the budget immediately and
-- two categories that happen to share a normalised name can no longer be
-- confused for one another. Everything 0013 documents about `mine`, `vis`,
-- the carry-forward in `eff`, and why every predicate in `spend` lives in
-- the ON clause still holds and is not repeated here.
create function get_budget_status(from_date date, to_date date)
  returns table (
    budget_id uuid, category_id uuid, category_label text,
    currency_code char(3), wallet_names text[], wallet_count int,
    spent_minor bigint, budget_minor bigint, budget_period_start date
  )
  language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  with mine as (
    select w.id, w.name, w.currency_code
    from public.wallets w
    where public.is_wallet_member(w.id) and w.archived_at is null
  ),
  vis as (
    select b.* from public.budgets b where public.budget_visible(b.id)
  ),
  keyed as (
    select v.id, v.category_id, v.period_start, v.amount_minor, v.currency_code,
           string_agg(bw.wallet_id::text, ',' order by bw.wallet_id) as set_key
    from vis v
    join public.budget_wallets bw on bw.budget_id = v.id
    where v.period_start <= from_date
    group by v.id, v.category_id, v.period_start, v.amount_minor, v.currency_code
  ),
  -- `distinct on` treats two NULL category_ids as equal, so overall caps
  -- carry forward per wallet set exactly as category budgets do.
  eff as (
    select distinct on (k.set_key, k.category_id) k.*
    from keyed k
    order by k.set_key, k.category_id, k.period_start desc
  ),
  -- The category test sits in the ON clause with the others: an overall cap
  -- (category_id null) counts every expense in the set; a category budget
  -- counts only its own, and an expense with NO category never matches a
  -- category budget -- the same two behaviours 0013's name join produced.
  spend as (
    select e.id as budget_id, coalesce(sum(-t.amount_minor), 0)::bigint as spent
    from eff e
    join public.budget_wallets bw on bw.budget_id = e.id
    join mine m on m.id = bw.wallet_id
    left join public.transactions t
      on t.wallet_id = bw.wallet_id
     and t.kind = 'expense'
     and t.deleted_at is null
     and t.occurred_on between from_date and to_date
     and (e.category_id is null or t.category_id = e.category_id)
    group by e.id
  ),
  scope as (
    select bw.budget_id, array_agg(m.name order by m.name) as names, count(*)::int as n
    from public.budget_wallets bw join mine m on m.id = bw.wallet_id
    group by bw.budget_id
  ),
  -- Correlated to t.wallet_id via budget_wallets, for the reason 0013
  -- spells out: a category budgeted for a SUBSET of wallets must still
  -- report its spending in the wallets it does not cover.
  uncovered as (
    select c.id as category_id, c.name as label,
           m.currency_code, sum(-t.amount_minor)::bigint as spent
    from public.transactions t
    join mine m on m.id = t.wallet_id
    join public.categories c on c.id = t.category_id
    where t.kind = 'expense' and t.deleted_at is null
      and t.occurred_on between from_date and to_date
      and not exists (
        select 1 from eff e
        join public.budget_wallets bw on bw.budget_id = e.id
        where bw.wallet_id = t.wallet_id
          and e.category_id = t.category_id
      )
    group by c.id, c.name, m.currency_code
  )
  select e.id, e.category_id, c.name,
         e.currency_code, s.names, s.n,
         sp.spent, e.amount_minor, e.period_start
  from eff e
  join spend sp on sp.budget_id = e.id
  join scope s on s.budget_id = e.id
  left join public.categories c on c.id = e.category_id
  union all
  select null::uuid, u.category_id, u.label, u.currency_code, null::text[], null::int,
         u.spent, null::bigint, null::date
  from uncovered u;
end $$;

revoke all on function get_budget_status(date, date) from public, anon;
grant execute on function get_budget_status(date, date) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- E. set_budget, on ids
-- ─────────────────────────────────────────────────────────────────────────
-- 0013's function with its first parameter changed from a name to an id.
-- Every guard 0013 documents at length (null args, positive amount, first
-- of month, non-empty set, no duplicates, EVERY-wallet membership via
-- cardinality()/unnest() -- see 0013's C1 finding -- no archived wallet,
-- one currency) is kept verbatim and not re-explained here. Two guards are
-- new, both placed AFTER membership so neither can be used to probe
-- another household: the set must sit in one household, and the category,
-- when given, must be an expense category of that household.
--
-- The name normalisation and the blank-string refusal are gone with the
-- name: a uuid is either a row or it is not, and "" cannot arrive in one.
-- An explicit NULL still means the set's overall cap.
create function set_budget(
  p_category_id uuid, p_period_start date, p_amount_minor bigint, p_wallet_ids uuid[]
) returns uuid
  language plpgsql security definer set search_path = '' as $$
declare
  v_currency char(3);
  v_space    uuid;
  v_kind     public.category_kind;
  v_count    int;
  v_existing uuid;
  v_key      text;
  v_id       uuid;
begin
  if p_period_start is null or p_amount_minor is null or p_wallet_ids is null then
    raise exception 'period, amount and accounts must not be null';
  end if;
  if p_amount_minor <= 0 then
    raise exception 'budget amount must be positive';
  end if;
  if p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'a budget period must start on the first of a month';
  end if;
  if cardinality(p_wallet_ids) = 0 then
    raise exception 'a budget must cover at least one account';
  end if;
  if cardinality(p_wallet_ids) <> (select count(distinct x) from unnest(p_wallet_ids) x) then
    raise exception 'the same account is listed twice in that set';
  end if;

  select count(*) into v_count from public.wallets w
   where w.id = any(p_wallet_ids) and public.is_wallet_member(w.id);
  if v_count <> cardinality(p_wallet_ids) then
    raise exception 'not a member of every account in that set';
  end if;

  if exists (
    select 1 from public.wallets w
    where w.id = any(p_wallet_ids) and w.archived_at is not null
  ) then
    raise exception 'an archived account cannot be part of a budget';
  end if;

  select count(distinct w.currency_code) into v_count from public.wallets w
   where w.id = any(p_wallet_ids);
  if v_count <> 1 then
    raise exception 'every account in a budget must use the same currency';
  end if;
  select distinct w.currency_code into v_currency from public.wallets w
   where w.id = any(p_wallet_ids);

  -- One household. Reachable only by a caller who belongs to two
  -- households and mixes their wallets; a budget cannot describe that, and
  -- budgets_category_same_space / budget_wallets_*_same_space would refuse
  -- the rows anyway -- this just says so in words first.
  select count(distinct w.space_id) into v_count from public.wallets w
   where w.id = any(p_wallet_ids);
  if v_count <> 1 then
    raise exception 'every account in a budget must belong to the same household';
  end if;
  select distinct w.space_id into v_space from public.wallets w
   where w.id = any(p_wallet_ids);

  -- The category, when given, must be THIS household's, and an expense
  -- category: budgets cap spending, so an income category is meaningless
  -- here rather than merely unusual. Scoped by space_id, not by
  -- is_space_member: the set's household is already established as the
  -- caller's own, so this cannot see into any other. An archived category
  -- is allowed -- an existing budget over a since-archived category must
  -- stay editable, and the picker never offers a new one.
  if p_category_id is not null then
    select c.kind into v_kind from public.categories c
     where c.id = p_category_id and c.space_id = v_space;
    if v_kind is null then
      raise exception 'that category does not belong to this household';
    end if;
    if v_kind <> 'expense' then
      raise exception 'a budget can only cover an expense category';
    end if;
  end if;

  v_key := (select string_agg(x::text, ',' order by x) from unnest(p_wallet_ids) x);

  select b.id into v_existing
    from public.budgets b
   where b.period_start = p_period_start
     and b.category_id is not distinct from p_category_id
     and (select string_agg(bw.wallet_id::text, ',' order by bw.wallet_id)
            from public.budget_wallets bw where bw.budget_id = b.id) = v_key
   limit 1;

  if v_existing is not null then
    update public.budgets set amount_minor = p_amount_minor where id = v_existing;
    return v_existing;
  end if;

  insert into public.budgets (created_by, currency_code, space_id, category_id, period_start, amount_minor)
  values (auth.uid(), v_currency, v_space, p_category_id, p_period_start, p_amount_minor)
  returning id into v_id;

  insert into public.budget_wallets (budget_id, wallet_id, space_id)
  select v_id, x, v_space from unnest(p_wallet_ids) x;

  return v_id;
end $$;

revoke all on function set_budget(uuid, date, bigint, uuid[]) from public, anon;
grant execute on function set_budget(uuid, date, bigint, uuid[]) to authenticated;
