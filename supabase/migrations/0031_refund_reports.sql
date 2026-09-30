-- supabase/migrations/0031_refund_reports.sql
--
-- Refunds, part 3 of 3: the spend lens. One view says what a refund counts
-- against (its expense's wallet, category and date); the breakdown and the
-- budget status read it instead of filtering on kind = 'expense'. Balances
-- and cash flow are deliberately untouched: they are the money lens, and a
-- repayment is money that arrived where and when it arrived (spec §3.3).

create view public.spend_lines with (security_invoker = true) as
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
    join public.transactions p on p.id = r.refund_of and p.deleted_at is null
   where r.kind = 'refund' and r.deleted_at is null;

revoke all on public.spend_lines from anon;
grant select on public.spend_lines to authenticated;

-- 0011's function, reading spend_lines. Grouping, the every-element
-- membership check and the output shape are unchanged. HAVING drops a
-- category whose repayments meet or exceed its spend: a pie cannot draw a
-- negative slice, and "you spent nothing net" is what that category means.
create or replace function public.get_category_breakdown(
  wallet_ids uuid[], from_date date, to_date date
) returns table(category_id uuid, name text, color_slot smallint, icon text, total_minor bigint)
  language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from unnest(wallet_ids) w(id) where not public.is_wallet_member(w.id)) then
    return;
  end if;

  return query
    select (array_agg(c.id order by c.id))[1],
           min(c.name),
           min(c.color_slot),
           min(c.icon),
           sum(s.spend_minor)::bigint
    from public.spend_lines s
    join public.categories c on c.id = s.category_id
    where s.wallet_id = any(wallet_ids)
      and s.occurred_on between from_date and to_date
    group by c.kind, lower(btrim(c.name))
    having sum(s.spend_minor) > 0
    order by 5 desc;
end $$;

-- 0023's function with `spend` and `uncovered` reading spend_lines. Every
-- other CTE is verbatim. `spent` is clamped at 0: an over-repaid category
-- has spent nothing against its budget, not a negative amount.
create or replace function public.get_budget_status(from_date date, to_date date)
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
  eff as (
    select distinct on (k.set_key, k.category_id) k.*
    from keyed k
    order by k.set_key, k.category_id, k.period_start desc
  ),
  spend as (
    select e.id as budget_id, greatest(coalesce(sum(s.spend_minor), 0), 0)::bigint as spent
    from eff e
    join public.budget_wallets bw on bw.budget_id = e.id
    join mine m on m.id = bw.wallet_id
    left join public.spend_lines s
      on s.wallet_id = bw.wallet_id
     and s.occurred_on between from_date and to_date
     and (e.category_id is null or s.category_id = e.category_id)
    group by e.id
  ),
  scope as (
    select bw.budget_id, array_agg(m.name order by m.name) as names, count(*)::int as n
    from public.budget_wallets bw join mine m on m.id = bw.wallet_id
    group by bw.budget_id
  ),
  uncovered as (
    select c.id as category_id, c.name as label,
           m.currency_code, sum(s.spend_minor)::bigint as spent
    from public.spend_lines s
    join mine m on m.id = s.wallet_id
    join public.categories c on c.id = s.category_id
    where s.occurred_on between from_date and to_date
      and not exists (
        select 1 from eff e
        join public.budget_wallets bw on bw.budget_id = e.id
        where bw.wallet_id = s.wallet_id
          and e.category_id = s.category_id
      )
    group by c.id, c.name, m.currency_code
    having sum(s.spend_minor) > 0
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
