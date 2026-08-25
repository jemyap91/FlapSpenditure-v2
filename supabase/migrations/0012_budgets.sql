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

-- Member-writable, matching transactions_member and categories_member.
-- Members are equal on money; owner-only is reserved for membership and
-- archiving.
create policy budgets_member on budgets
  for all to authenticated
  using (is_wallet_member(wallet_id)) with check (is_wallet_member(wallet_id));
