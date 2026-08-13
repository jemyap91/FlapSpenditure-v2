-- supabase/migrations/0006_aggregates.sql

-- Plain SELECTs re-evaluate the RLS subquery (is_wallet_member, via the
-- wallets/transactions policies) per scanned row. These check membership
-- ONCE up front, then aggregate freely.
--
-- search_path is set to '' (empty), not 'public' as the brief had it, with
-- every reference below schema-qualified (public.wallets, public.
-- transactions, public.categories, public.is_wallet_member). Postgres
-- searches pg_temp for unqualified relation/function names BEFORE
-- consulting search_path at all, so `set search_path = public` alone does
-- NOT stop a caller from creating a temp table or function that shadows one
-- of these names. That is a demonstrated, previously-fixed vulnerability on
-- this branch (0004_rls.sql, 0005_transfer_fn.sql) -- applied here for the
-- same reason and, for get_category_breakdown/get_cash_flow specifically,
-- because SECURITY DEFINER means an unqualified reference would be a
-- privilege-escalation vector, not just a self-sabotage risk.

-- get_wallet_balances is SECURITY INVOKER: it runs under the caller's own
-- RLS, so wallets_select (is_wallet_member) already restricts the join to
-- wallets the caller belongs to -- no explicit membership check is needed
-- or performed here.
create function get_wallet_balances()
  returns table(wallet_id uuid, balance_minor bigint, currency_code char(3))
  language sql stable security invoker set search_path = '' as $$
  select w.id,
         w.starting_balance_minor + coalesce(sum(t.amount_minor) filter (where t.deleted_at is null), 0),
         w.currency_code
  from public.wallets w
  left join public.transactions t on t.wallet_id = w.id
  where w.archived_at is null
  group by w.id, w.starting_balance_minor, w.currency_code
$$;

-- Membership is checked ONCE up front, for EVERY element of wallet_ids: if
-- unnest(wallet_ids) contains even one id the caller is not a member of,
-- the function returns empty rather than filtering that id out and
-- returning data for the rest. An unauthorised wallet id therefore yields
-- empty rather than an error, so a stale client cannot probe for existence,
-- and a mixed array (one authorised wallet + one wallet belonging to
-- another user) cannot be used to read the authorised wallet's data by
-- riding along with an unauthorised id -- the whole call is denied.
create function get_category_breakdown(
  wallet_ids uuid[], from_date date, to_date date
) returns table(category_id uuid, name text, color_slot smallint, icon text, total_minor bigint)
  language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from unnest(wallet_ids) w(id) where not public.is_wallet_member(w.id)) then
    return;
  end if;

  return query
    select c.id, c.name, c.color_slot, c.icon, sum(-t.amount_minor)::bigint
    from public.transactions t
    join public.categories c on c.id = t.category_id
    where t.wallet_id = any(wallet_ids)
      and t.deleted_at is null
      and t.kind = 'expense'          -- transfers (and income) are excluded from this report (§3.3)
      and t.occurred_on between from_date and to_date
    group by c.id, c.name, c.color_slot, c.icon
    order by 5 desc;
end $$;

-- Cash flow INCLUDES transfers (§3.3) -- no kind filter below, only
-- deleted_at and the date range. Same one-shot, every-element membership
-- check as get_category_breakdown, for the same reason.
create function get_cash_flow(
  wallet_ids uuid[], from_date date, to_date date, bucket text default 'day'
) returns table(bucket_start date, in_minor bigint, out_minor bigint)
  language plpgsql stable security definer set search_path = '' as $$
begin
  if bucket not in ('day','week','month') then
    raise exception 'bucket must be day, week or month';
  end if;
  if exists (select 1 from unnest(wallet_ids) w(id) where not public.is_wallet_member(w.id)) then
    return;
  end if;

  return query
    select date_trunc(bucket, t.occurred_on)::date,
           coalesce(sum(t.amount_minor) filter (where t.amount_minor > 0), 0)::bigint,
           coalesce(sum(-t.amount_minor) filter (where t.amount_minor < 0), 0)::bigint
    from public.transactions t
    where t.wallet_id = any(wallet_ids)
      and t.deleted_at is null
      and t.occurred_on between from_date and to_date
    group by 1
    order by 1;
end $$;
