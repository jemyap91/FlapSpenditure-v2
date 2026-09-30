-- supabase/migrations/0032_refund_household_fixes.sql
--
-- Refunds, whole-branch review fixes. Every replaced definition below is
-- the latest one copied verbatim (leave_space_impl from 0025,
-- get_entry_suggestions from 0026, spend_lines from 0031); only the lines
-- the comments call out differ. Grants are re-stated for each.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Leaving a household cannot split a repayment from its expense
-- ─────────────────────────────────────────────────────────────────────────
-- 0025's function plus the block after the moving wallet set is known.
create or replace function leave_space_impl(p_space uuid, p_user uuid)
  returns table(wallets_moved int, budgets_moved int, budgets_trimmed int)
  language plpgsql security definer set search_path = '' as $$
declare
  v_role          public.member_role;
  v_new           uuid;
  v_wallets       uuid[];
  v_moved_budgets uuid[];
  v_trimmed       int;
begin
  -- Transaction-scoped and never reset: SET CONSTRAINTS has no "back to
  -- immediate for the rest of this statement" and PostgreSQL gives no way
  -- to restore only the constraints this function deferred. Harmless under
  -- the one-RPC-per-transaction shape PostgREST gives every caller here.
  -- If this is ever called from inside a larger transaction, every key on
  -- that transaction's later statements is checked at COMMIT instead of at
  -- statement end -- same outcome, later and less locatable error.
  set constraints all deferred;

  select sm.role into v_role from public.space_members sm where sm.space_id = p_space and sm.user_id = p_user;
  if v_role is null then
    raise exception 'not a member of that household';
  end if;
  if v_role = 'owner' then
    raise exception 'the household owner cannot leave';
  end if;

  -- handle_new_user (0022) already gave this person a household at signup,
  -- dormant while they were a member elsewhere. Reuse it rather than
  -- minting another: without this, leaving-and-rejoining piles up empty
  -- owned households nobody can see a reason for.
  select sm.space_id into v_new
    from public.space_members sm
   where sm.user_id = p_user and sm.role = 'owner' and sm.space_id <> p_space
   order by sm.joined_at asc
   limit 1;
  if v_new is null then
    insert into public.spaces (name)
    values (left(coalesce((select nullif(btrim(p.display_name), '') from public.profiles p where p.id = p_user), 'My'), 49) || ' household')
    returning id into v_new;
    insert into public.space_members (space_id, user_id, role) values (v_new, p_user, 'owner');
  end if;

  select coalesce(array_agg(w.id), array[]::uuid[]) into v_wallets
    from public.wallets w where w.owner_id = p_user and w.space_id = p_space;

  -- 0032: a repayment and its expense share a space_id (0030's composite
  -- key), so a link with exactly ONE end in a moving wallet would be split
  -- across households and fail that deferred key at commit. The key ignores
  -- deleted_at and refund_shape forbids unlinking, so a soft-deleted
  -- repayment on such a link is hard-deleted here: nothing else ever could.
  -- A live one refuses the leave with a message the app maps, before any
  -- row moves. Both ends of a link are in p_space, hence the space filter.
  delete from public.transactions r
   using public.transactions e
   where e.id = r.refund_of
     and r.space_id = p_space
     and r.kind = 'refund'
     and r.deleted_at is not null
     and (r.wallet_id = any(v_wallets)) <> (e.wallet_id = any(v_wallets));
  if exists (select 1
               from public.transactions r
               join public.transactions e on e.id = r.refund_of
              where r.space_id = p_space
                and r.kind = 'refund'
                and r.deleted_at is null
                and (r.wallet_id = any(v_wallets)) <> (e.wallet_id = any(v_wallets))) then
    raise exception 'repayments link wallets that would be split';
  end if;

  select coalesce(array_agg(b.id), array[]::uuid[]) into v_moved_budgets
    from public.budgets b
   where b.space_id = p_space
     and exists (select 1 from public.budget_wallets bw where bw.budget_id = b.id)
     and not exists (select 1 from public.budget_wallets bw
                      where bw.budget_id = b.id and not (bw.wallet_id = any(v_wallets)));

  -- Categories the moving rows need, created in the new household where no
  -- active same-named one exists (the seed trigger already made 16). A
  -- category that exists in the destination only ARCHIVED is recreated
  -- active on purpose: the repoint joins below require `n.archived_at is
  -- null`, so an archived-only match would leave the moving rows pointing
  -- at the old household and the deferred key would fail at commit. The
  -- person can archive it again afterwards.
  insert into public.categories (space_id, name, kind, color_slot, icon, sort_order, is_default)
  select distinct on (c.kind, lower(btrim(c.name)))
         v_new, c.name, c.kind, c.color_slot, c.icon, 900, false
    from public.categories c
   where c.id in (
           select t.category_id from public.transactions t
            where t.wallet_id = any(v_wallets) and t.category_id is not null
           union
           select r.category_id from public.recurring_rules r where r.wallet_id = any(v_wallets)
           union
           select b.category_id from public.budgets b
            where b.id = any(v_moved_budgets) and b.category_id is not null)
     and not exists (select 1 from public.categories n
                      where n.space_id = v_new and n.kind = c.kind
                        and lower(btrim(n.name)) = lower(btrim(c.name)) and n.archived_at is null)
   order by c.kind, lower(btrim(c.name)), (c.archived_at is null) desc, c.created_at;

  update public.transactions t
     set category_id = n.id, space_id = v_new
    from public.categories o
    join public.categories n
      on n.space_id = v_new and n.kind = o.kind
     and lower(btrim(n.name)) = lower(btrim(o.name)) and n.archived_at is null
   where t.wallet_id = any(v_wallets) and t.category_id = o.id;
  update public.transactions set space_id = v_new
   where wallet_id = any(v_wallets) and category_id is null;

  update public.recurring_rules r
     set category_id = n.id, space_id = v_new
    from public.categories o
    join public.categories n
      on n.space_id = v_new and n.kind = o.kind
     and lower(btrim(n.name)) = lower(btrim(o.name)) and n.archived_at is null
   where r.wallet_id = any(v_wallets) and r.category_id = o.id;

  update public.budgets b
     set category_id = n.id, space_id = v_new
    from public.categories o
    join public.categories n
      on n.space_id = v_new and n.kind = o.kind
     and lower(btrim(n.name)) = lower(btrim(o.name)) and n.archived_at is null
   where b.id = any(v_moved_budgets) and b.category_id = o.id;
  update public.budgets set space_id = v_new
   where id = any(v_moved_budgets) and category_id is null;
  update public.budget_wallets set space_id = v_new where budget_id = any(v_moved_budgets);

  -- Budgets trimmed, not links trimmed: a mixed budget can lose several
  -- wallets at once and the caller reports "n budgets kept their staying
  -- wallets", so count the budgets the deletion touched.
  with d as (
    delete from public.budget_wallets bw
     where bw.wallet_id = any(v_wallets) and not (bw.budget_id = any(v_moved_budgets))
    returning bw.budget_id)
  select count(distinct budget_id) into v_trimmed from d;

  update public.wallets set space_id = v_new, shared_with_household = false where id = any(v_wallets);
  delete from public.wallet_members where wallet_id = any(v_wallets) and user_id <> p_user;
  update public.wallet_members set space_id = v_new where wallet_id = any(v_wallets) and user_id = p_user;

  -- Rows on wallets that stay behind; the cascade from space_members would
  -- take these too, but say it.
  delete from public.wallet_members m using public.wallets w
   where w.id = m.wallet_id and w.space_id = p_space and m.user_id = p_user;
  delete from public.space_members where space_id = p_space and user_id = p_user;

  return query select cardinality(v_wallets), cardinality(v_moved_budgets), v_trimmed;
end $$;


revoke all on function leave_space_impl(uuid, uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Repayments the caller cannot see
-- ─────────────────────────────────────────────────────────────────────────
-- A repayment someone else recorded into a wallet this caller is not a
-- member of still pins the expense (guard_refunded_expense, 0030), but RLS
-- hides it from the expense's panel. This says how many, and nothing else:
-- a caller who cannot see the expense's own wallet gets 0, so it cannot be
-- used to probe expenses elsewhere.
create function public.count_hidden_repayments(p_expense uuid)
  returns int
  language plpgsql stable security definer set search_path = '' as $$
declare
  v_wallet uuid;
begin
  select t.wallet_id into v_wallet from public.transactions t where t.id = p_expense;
  if v_wallet is null or not public.is_wallet_member(v_wallet) then
    return 0;
  end if;
  return (select count(*)::int
            from public.transactions r
           where r.refund_of = p_expense
             and r.kind = 'refund'
             and r.deleted_at is null
             and not public.is_wallet_member(r.wallet_id));
end $$;

revoke all on function public.count_hidden_repayments(uuid) from public, anon;
grant execute on function public.count_hidden_repayments(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Entry suggestions come from expenses and income only
-- ─────────────────────────────────────────────────────────────────────────
-- 0026's function with `kind <> 'transfer'` narrowed to
-- `kind in ('expense', 'income')`: a repayment's note ("Alice") is a name,
-- not a merchant or a purchase to suggest.
create or replace function get_entry_suggestions()
  returns table(merchant text, note text, category_id uuid, uses int, last_used date)
  language sql stable security definer set search_path = '' as $$
  with mine as (
    select nullif(btrim(t.merchant), '') as merchant,
           nullif(btrim(t.note), '')     as note,
           t.category_id,
           t.occurred_on
      from public.transactions t
     where t.created_by = auth.uid()
       and t.deleted_at is null
       and t.kind in ('expense', 'income')
       and t.occurred_on >= (current_date - interval '12 months')::date
       and (nullif(btrim(t.merchant), '') is not null or nullif(btrim(t.note), '') is not null)
  ),
  spelled as (
    select m.merchant, m.note, m.category_id, m.occurred_on,
           lower(m.merchant) as mkey,
           lower(m.note)     as nkey,
           first_value(m.merchant) over (partition by lower(m.merchant)
                                         order by m.occurred_on desc, m.merchant) as merchant_spelling,
           first_value(m.note)     over (partition by lower(m.merchant), lower(m.note)
                                         order by m.occurred_on desc, m.note) as note_spelling
      from mine m
  )
  select s.merchant_spelling,
         s.note_spelling,
         mode() within group (order by s.category_id),
         count(*)::int,
         max(s.occurred_on)
    from spelled s
   group by s.mkey, s.nkey, s.merchant_spelling, s.note_spelling
   order by count(*) desc, max(s.occurred_on) desc
   limit 200
$$;

revoke all on function get_entry_suggestions() from public, anon;
grant execute on function get_entry_suggestions() to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. spend_lines follows a link only to an expense
-- ─────────────────────────────────────────────────────────────────────────
-- 0031's view plus `and p.kind = 'expense'` on the refund branch's join.
-- The triggers already keep every parent an expense; this keeps the spend
-- lens from depending on that.
create or replace view public.spend_lines with (security_invoker = true) as
  select t.id            as transaction_id,
         t.wallet_id,
         t.category_id,
         t.occurred_on,
         -t.amount_minor as spend_minor,
         t.currency_code
    from public.transactions t
   where t.kind = 'expense' and t.deleted_at is null
  union all
  select r.id,
         p.wallet_id,
         p.category_id,
         p.occurred_on,
         -r.amount_minor,
         r.currency_code
    from public.transactions r
    join public.transactions p on p.id = r.refund_of and p.deleted_at is null and p.kind = 'expense'
   where r.kind = 'refund' and r.deleted_at is null;

revoke all on public.spend_lines from anon;
grant select on public.spend_lines to authenticated;
