-- supabase/migrations/0015_recurring.sql
--
-- Recurring expenses and income (spec 2026-09-01-recurring-entries-design).
-- Numbered 0015, not 0014: 0014_rls_initplan.sql exists unmerged on branch
-- worktree-perf, and the gap lets both land without renumbering.
--
-- Occurrence DATES are not stored. They are computed from anchor_on by
-- src/lib/recurrence.ts; this schema stores only the rule, the explicit
-- skips, and the link from a recorded transaction back to its rule.

create type recur_interval as enum ('weekly', 'fortnightly', 'monthly', 'yearly');

create table recurring_rules (
  id             uuid primary key default gen_random_uuid(),
  wallet_id      uuid not null references wallets(id) on delete cascade,
  created_by     uuid references auth.users(id) on delete set null,
  name           text not null check (length(trim(name)) between 1 and 60),
  kind           txn_kind not null,
  amount_minor   bigint not null check (amount_minor <> 0),
  currency_code  char(3) not null references currencies(code),
  category_id    uuid not null references categories(id) on delete restrict,
  interval_unit  recur_interval not null,
  anchor_on      date not null,
  ends_on        date,
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Mirrors 0003's own sign constraints: a rule must not be able to describe
  -- a transaction the ledger would refuse to hold.
  constraint rule_expense_is_negative check (kind <> 'expense' or amount_minor < 0),
  constraint rule_income_is_positive  check (kind <> 'income'  or amount_minor > 0),
  -- Transfers are out of scope (spec §1.2): they are a PAIR of rows sharing a
  -- transfer_id with no category, a different write with a different failure
  -- mode. Enforced in the table, not only in a form -- a Server Function is
  -- reachable by direct POST regardless of what UI exists.
  constraint rule_kind_not_transfer   check (kind <> 'transfer'),
  constraint rule_ends_after_anchor   check (ends_on is null or ends_on >= anchor_on)
);

create index recurring_rules_wallet on recurring_rules (wallet_id) where archived_at is null;

-- One row per period the user explicitly declined. The composite primary key
-- IS the idempotency guarantee: skipping twice is a no-op, not two rows.
create table recurring_skips (
  rule_id       uuid not null references recurring_rules(id) on delete cascade,
  occurrence_on date not null,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  primary key (rule_id, occurrence_on)
);

-- `on delete set null`, NOT cascade -- the opposite of wallet_id's, and
-- deliberately. Deleting a rule must never delete money that was actually
-- spent; those transactions stay and simply stop pointing at a rule.
alter table transactions
  add column recurring_id uuid references recurring_rules(id) on delete set null;

-- Makes Record idempotent: a double tap, a retried request, or two tabs
-- cannot produce two rent rows for 1 July. Partial on deleted_at so that
-- deleting a recorded occurrence genuinely frees it to be recorded again.
create unique index transactions_recurring_occurrence
  on transactions (recurring_id, occurred_on)
  where recurring_id is not null and deleted_at is null;

alter table recurring_rules enable row level security;
alter table recurring_skips enable row level security;

-- Reachability first: this project's default ACL for schema public grants
-- authenticated no DML at all, so without these grants the policies below are
-- unreachable -- every query fails the privilege check before RLS is
-- consulted. `revoke all` first also removes table-level TRUNCATE, which is
-- NOT subject to RLS. Same reasoning as 0004_rls.sql's own comment.
revoke all on recurring_rules from anon, authenticated;
revoke all on recurring_skips from anon, authenticated;
grant select, insert, update, delete on recurring_rules to authenticated;
-- No UPDATE on skips: a skip has nothing to change. Undoing one is a DELETE.
grant select, insert, delete on recurring_skips to authenticated;

-- Member-writable, matching transactions_member, categories_member and
-- budgets_member. Members are equal on ledger content; owner-only is reserved
-- for membership and for archiving a WALLET.
create policy recurring_rules_member on recurring_rules
  for all to authenticated
  using (is_wallet_member(wallet_id)) with check (is_wallet_member(wallet_id));

-- Scoped through the rule's wallet. The subquery reads recurring_rules, which
-- is itself RLS-protected, so it sees only rules this caller may already see
-- -- which is the intended scoping here, not an accident.
create policy recurring_skips_member on recurring_skips
  for all to authenticated
  using (
    exists (
      select 1 from recurring_rules r
      where r.id = recurring_skips.rule_id and is_wallet_member(r.wallet_id)
    )
  )
  with check (
    exists (
      select 1 from recurring_rules r
      where r.id = recurring_skips.rule_id and is_wallet_member(r.wallet_id)
    )
  );
