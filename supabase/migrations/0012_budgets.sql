-- supabase/migrations/0012_budgets.sql
--
-- Monthly spending caps, per category and per wallet (spec §1).
--
-- A budget belongs to a WALLET, not a person, so every member of a shared
-- wallet sees the identical figure. A wallet also has exactly one currency,
-- so a budget needs no currency of its own and never meets the
-- multi-currency problem the dashboard has to disclose around.

create table budgets (
  id            uuid primary key default gen_random_uuid(),
  wallet_id     uuid not null references wallets(id) on delete cascade,
  -- NULL means "the wallet's overall cap". One nullable column rather than a
  -- second table: both answer the same question, differing only in scope.
  category_id   uuid references categories(id) on delete cascade,
  -- Always the first day of a month. `extract(day ...) = 1` rather than
  -- `date_trunc('month', ...)`, which takes a timestamp and would need a
  -- cast inside a CHECK; a day-of-month test states the same rule without
  -- depending on cast immutability.
  period_start  date not null check (extract(day from period_start) = 1),
  -- A zero budget is indistinguishable from no budget; deleting the row is
  -- how a budget is removed.
  amount_minor  bigint not null check (amount_minor > 0),
  created_at    timestamptz not null default now()
);

-- TWO partial indexes, not one constraint. Postgres treats NULLs as DISTINCT
-- in a unique index, so `unique (wallet_id, category_id, period_start)` would
-- silently permit any number of overall caps for the same wallet and month,
-- and the tracking query would then pick one arbitrarily.
create unique index budgets_category_period
  on budgets (wallet_id, category_id, period_start) where category_id is not null;
create unique index budgets_overall_period
  on budgets (wallet_id, period_start) where category_id is null;

create index budgets_wallet_period on budgets (wallet_id, period_start desc);

-- A budget may not reference another wallet's category. Same pattern 0008
-- established for transactions, resting on the same categories (id, wallet_id)
-- unique constraint. MATCH SIMPLE skips the check when category_id is null,
-- which is exactly right for the overall cap.
alter table budgets
  add constraint budgets_category_same_wallet
  foreign key (category_id, wallet_id) references categories (id, wallet_id);

alter table budgets enable row level security;
grant select, insert, update, delete on budgets to authenticated;

-- Column-restrict UPDATE, closing the exact hole 0004_rls.sql documents at
-- length for transactions: `budgets_member`'s USING/WITH CHECK both ask
-- the identical is_wallet_member(wallet_id) question, one against the OLD
-- row and one against the NEW, so RLS alone cannot stop a member of two
-- wallets from doing `update budgets set wallet_id = <my other wallet>`
-- and moving a shared wallet's budget out from under its co-members.
-- set_budget's DO UPDATE writes only amount_minor, and its `returning id`
-- needs only SELECT, so narrowing to that single column does not touch the
-- upsert this function performs.
revoke update on budgets from authenticated;
grant update (amount_minor) on budgets to authenticated;

-- Member-writable, matching transactions_member and categories_member.
-- Members are equal on money; owner-only is reserved for membership and
-- archiving.
create policy budgets_member on budgets
  for all to authenticated
  using (is_wallet_member(wallet_id)) with check (is_wallet_member(wallet_id));

-- The effective budget for a month is the most recent row at or BEFORE it, so
-- one row set in September governs October onward, and raising the amount in
-- October leaves September measured against September's row (spec §2).
--
-- No wallet-ids parameter: this self-scopes via is_wallet_member, the same
-- shape get_wallet_members/get_pending_invites use, so there is no
-- caller-supplied filter to tamper with.
create function get_budget_status(from_date date, to_date date)
  returns table(
    wallet_id uuid, wallet_name text, currency_code char(3),
    category_id uuid, category_name text, color_slot smallint, icon text,
    spent_minor bigint, budget_minor bigint,
    -- The underlying `budgets` row this figure came from -- both NULL when
    -- there is no effective budget (spending-only row). The UI
    -- (src/app/(app)/budgets, Task 5) needs `budget_id` to call
    -- `removeBudget(id)`: this aggregate is not a plain select over
    -- `budgets`, so there is no other column here that already carries it.
    -- `budget_period_start` rides along so the UI can tell a CURRENT-month
    -- budget from one carried forward from an earlier month (spec: "the
    -- effective budget for a month is the most recent row at or before
    -- it") and disclose that a Remove click on an old row is not scoped to
    -- just this month.
    budget_id uuid, budget_period_start date
  )
  language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  with mine as (
    select w.id, w.name, w.currency_code
    from public.wallets w
    where public.is_wallet_member(w.id) and w.archived_at is null
  ),
  eff as (
    select distinct on (b.wallet_id, b.category_id)
           b.wallet_id, b.category_id, b.amount_minor, b.id, b.period_start
    from public.budgets b
    join mine m on m.id = b.wallet_id
    where b.period_start <= from_date
    order by b.wallet_id, b.category_id, b.period_start desc
  ),
  -- EXPENSES ONLY. t.kind = 'expense' is the same filter
  -- get_category_breakdown applies. Transfers are excluded twice over: by
  -- kind, and because 0003's transfer_shape CHECK forces their category_id
  -- to NULL. Income cannot leak in even if someone budgets an income
  -- category.
  spend as (
    select t.wallet_id, t.category_id, sum(-t.amount_minor)::bigint as spent
    from public.transactions t
    join mine m on m.id = t.wallet_id
    where t.kind = 'expense'
      and t.deleted_at is null
      and t.occurred_on between from_date and to_date
    group by t.wallet_id, t.category_id
  ),
  overall as (
    select s.wallet_id, sum(s.spent)::bigint as spent
    from spend s group by s.wallet_id
  )
  -- The wallet's overall cap. Deliberately NOT the sum of the category rows:
  -- it counts every expense in the wallet, including categories with no
  -- budget of their own. That is what makes a cap useful when only some
  -- categories are budgeted.
  select m.id, m.name, m.currency_code,
         null::uuid, null::text, null::smallint, null::text,
         coalesce(o.spent, 0)::bigint, e.amount_minor,
         e.id, e.period_start
  from mine m
  left join overall o on o.wallet_id = m.id
  left join eff e on e.wallet_id = m.id and e.category_id is null
  where o.spent is not null or e.amount_minor is not null

  union all

  -- One row per category that has a budget OR has spending. budget_minor is
  -- NULL (never 0) for a category with spending but no budget: "no budget"
  -- and "budgeted at zero" must stay distinguishable, and amount_minor > 0
  -- means a real budget is never 0 anyway.
  select m.id, m.name, m.currency_code,
         c.id, c.name, c.color_slot, c.icon,
         coalesce(s.spent, 0)::bigint, e.amount_minor,
         e.id, e.period_start
  from mine m
  join public.categories c on c.wallet_id = m.id
  left join spend s on s.wallet_id = m.id and s.category_id = c.id
  left join eff e on e.wallet_id = m.id and e.category_id = c.id
  where s.spent is not null or e.amount_minor is not null;
end $$;

revoke all on function get_budget_status(date, date) from public, anon;
grant execute on function get_budget_status(date, date) to authenticated;

-- Writing a budget needs INSERT ... ON CONFLICT, and the two uniqueness rules
-- above are PARTIAL indexes. Postgres can only infer a partial index when the
-- statement repeats the index predicate, and PostgREST's `onConflict` emits a
-- bare column list -- so `from("budgets").upsert(...)` fails outright with
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification". The upsert therefore lives here, where the predicate can be
-- written. The two shapes need two branches because an ON CONFLICT predicate
-- is part of the statement, not a value, so it cannot be parameterised.
--
-- security invoker, following create_transfer (0005): this function SHOULD run
-- under the caller's RLS, so budgets_member decides whether the write lands.
-- The explicit is_wallet_member guard is belt-and-braces for the error message
-- -- without it RLS still refuses, but as a policy violation rather than a
-- sentence. search_path is set to '' with everything schema-qualified, for the
-- reason 0005 documents at length: not privilege escalation here, but so an
-- unqualified name cannot silently resolve to a caller-created temp table.
create function set_budget(
  p_wallet_id uuid, p_category_id uuid, p_period_start date, p_amount_minor bigint
) returns uuid
  language plpgsql security invoker set search_path = '' as $$
declare
  bid uuid;
begin
  -- Explicit null checks, for the reason create_transfer documents: a plpgsql
  -- parameter cannot carry `not null`, and `p_amount_minor <= 0` alone
  -- evaluates to NULL rather than true, which plpgsql's `if` treats as false.
  if p_wallet_id is null or p_period_start is null or p_amount_minor is null then
    raise exception 'wallet, period and amount must not be null';
  end if;
  if p_amount_minor <= 0 then
    raise exception 'budget amount must be positive';
  end if;
  if not public.is_wallet_member(p_wallet_id) then
    raise exception 'not a member of that wallet';
  end if;

  if p_category_id is null then
    insert into public.budgets (wallet_id, category_id, period_start, amount_minor)
    values (p_wallet_id, null, p_period_start, p_amount_minor)
    on conflict (wallet_id, period_start) where category_id is null
      do update set amount_minor = excluded.amount_minor
    returning id into bid;
  else
    insert into public.budgets (wallet_id, category_id, period_start, amount_minor)
    values (p_wallet_id, p_category_id, p_period_start, p_amount_minor)
    on conflict (wallet_id, category_id, period_start) where category_id is not null
      do update set amount_minor = excluded.amount_minor
    returning id into bid;
  end if;

  return bid;
end $$;

revoke all on function set_budget(uuid, uuid, date, bigint) from public, anon;
grant execute on function set_budget(uuid, uuid, date, bigint) to authenticated;
