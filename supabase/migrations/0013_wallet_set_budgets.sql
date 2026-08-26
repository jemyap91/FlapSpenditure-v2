-- supabase/migrations/0013_wallet_set_budgets.sql

-- 0012 keyed a budget to exactly one wallet. A budget now carries a SET of
-- wallets (spec 2026-08-25). 0012 was never applied to the hosted database,
-- so this drops and recreates instead of migrating data.
--
-- CORRECTION to this migration's original plan: `cascade` on a DROP TABLE
-- does NOT reach get_budget_status or set_budget, even though both query
-- budgets in their body. Postgres's dependency tracking for a PL/pgSQL
-- function only covers its signature (parameter/return types) -- the SQL
-- text inside the body is opaque to it, so a table referenced only via
-- `from public.budgets` inside the function is invisible to CASCADE.
-- Verified empirically: after `drop table budgets cascade` alone, both
-- functions were still present in pg_proc and, when called, failed at
-- runtime with "column b.wallet_id does not exist" / "column \"wallet_id\"
-- of relation \"budgets\" does not exist" -- silently broken rather than
-- gone. Both are dropped explicitly below so Task 2 and Task 3 recreate
-- them against a clean slate instead of colliding with (or masking) a
-- stale, now-incompatible definition.
drop table if exists budgets cascade;
drop function if exists get_budget_status(date, date);
drop function if exists set_budget(uuid, uuid, date, bigint);

create table budgets (
  id            uuid primary key default gen_random_uuid(),
  -- Provenance, NOT permission: who can see this budget is decided entirely
  -- by its wallet set (budgets_visible below), never by created_by.
  created_by    uuid not null references auth.users(id),
  -- Denormalised from the set's wallets, which must all share it. Stored so a
  -- budget is self-describing and so a primary-currency shift is visible
  -- rather than silently matching nothing.
  currency_code char(3) not null,
  -- lower(btrim(name)) of the category, or NULL for this set's overall cap.
  -- A NAME, not an id, because categories are wallet-scoped since 0008 and a
  -- budget spanning wallets has no single category row to reference.
  category_key  text,
  period_start  date not null check (extract(day from period_start) = 1),
  amount_minor  bigint not null check (amount_minor > 0),
  created_at    timestamptz not null default now()
);

create table budget_wallets (
  budget_id uuid not null references budgets(id) on delete cascade,
  wallet_id uuid not null references wallets(id) on delete cascade,
  primary key (budget_id, wallet_id)
);

create index budget_wallets_wallet on budget_wallets (wallet_id);

alter table budgets enable row level security;
alter table budget_wallets enable row level security;

-- A budget is visible to exactly those who can see ALL the money it covers.
-- One rule, no flag: a set of one shared wallet stays shared with that
-- wallet's members (0012's behaviour); a set spanning personal wallets is
-- personal. A budget covering a wallet you are not in is unrepresentable, so
-- it cannot surface figures derived from spending you cannot see.
--
-- HAZARD: `not exists` over zero rows is TRUE, so a budget with NO wallets
-- would be visible to everyone. set_budget (Task 3) refuses to create one and
-- get_budget_status (Task 2) ignores any that exists. This is the single
-- fails-open case in an otherwise fails-closed design; rls.sql tests it.
create policy budgets_visible on budgets for all to authenticated
using (
  not exists (
    select 1 from budget_wallets bw
    where bw.budget_id = budgets.id and not is_wallet_member(bw.wallet_id)
  )
)
with check (
  not exists (
    select 1 from budget_wallets bw
    where bw.budget_id = budgets.id and not is_wallet_member(bw.wallet_id)
  )
);

-- Gated on the wallet named in the row, so the join table cannot be read to
-- enumerate wallet ids belonging to other people.
create policy budget_wallets_member on budget_wallets for all to authenticated
using (is_wallet_member(wallet_id)) with check (is_wallet_member(wallet_id));

-- 0004's own comment: the default ACL gives `authenticated` no DML, so a
-- policy without a grant is dead code.
grant select, insert, delete on budgets to authenticated;
-- Column-restricted UPDATE, matching transactions_member and the fix made to
-- 0012: `using` sees the old row and `with check` the new one, both asking the
-- same question, so an unrestricted grant would let a member re-point a budget
-- by changing a column the policy cannot distinguish.
grant update (amount_minor) on budgets to authenticated;
grant select, insert, delete on budget_wallets to authenticated;
