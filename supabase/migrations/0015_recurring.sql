-- supabase/migrations/0015_recurring.sql
--
-- Recurring expenses and income (spec 2026-09-01-recurring-entries-design).
-- Numbered 0015, not 0014: 0014_rls_initplan.sql exists unmerged on branch
-- worktree-perf, and the gap lets both land without renumbering.
--
-- Occurrence DATES are not stored. They are computed from anchor_on by
-- src/lib/recurrence.ts; this schema stores only the rule, the explicit
-- skips, and the link from a recorded transaction back to its rule.
--
-- Fix round 1 (task-2-fix-1): this migration is unmerged and undeployed, so
-- every defect the review found is fixed IN PLACE below rather than in a
-- follow-up 0016 -- see each "Fix N" comment for what changed and why.

create type recur_interval as enum ('weekly', 'fortnightly', 'monthly', 'yearly');

create table recurring_rules (
  id             uuid primary key default gen_random_uuid(),
  wallet_id      uuid not null references wallets(id) on delete cascade,
  created_by     uuid references auth.users(id) on delete set null,
  name           text not null check (length(trim(name)) between 1 and 60),
  kind           txn_kind not null,
  amount_minor   bigint not null check (amount_minor <> 0),
  currency_code  char(3) not null references currencies(code),
  -- Fix 2 (review round 1): FK moved to the composite constraint below --
  -- see recurring_rules_category_same_wallet.
  category_id    uuid not null,
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
  constraint rule_ends_after_anchor   check (ends_on is null or ends_on >= anchor_on),

  -- Fix 2 (review round 1, IMPORTANT) -- a rule could be accepted carrying a
  -- category belonging to a DIFFERENT wallet: the plain `references
  -- categories(id)` this replaced only checked the category existed
  -- anywhere, not that it was this rule's own wallet's. Recording such a
  -- rule would then produce a transaction violating 0008's
  -- transactions_category_same_wallet, so the rule was silently
  -- un-recordable -- the failure surfaced at Record time, far from the
  -- Create form that actually caused it. Same pattern 0008 established for
  -- transactions (transactions_category_same_wallet) and 0012 repeated for
  -- budgets (budgets_category_same_wallet), resting on the same categories
  -- (id, wallet_id) unique constraint (0008). MATCH SIMPLE (the default)
  -- would skip this check if category_id were ever nullable, but it isn't
  -- here -- every rule requires a category.
  constraint recurring_rules_category_same_wallet
    foreign key (category_id, wallet_id) references categories (id, wallet_id) on delete restrict,

  -- Fix 3 (review round 1, IMPORTANT) -- id+wallet_id together, so
  -- transactions can hang a composite FK off this table and pin a recorded
  -- occurrence to the SAME wallet as its rule. See
  -- transactions_recurring_same_wallet below for what this closes.
  constraint recurring_rules_id_wallet unique (id, wallet_id)
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
--
-- Fix 3 (review round 1, IMPORTANT) -- cross-wallet occurrence squatting.
-- The original column carried only a PLAIN `references recurring_rules(id)`
-- FK, with no tie to the transaction's own wallet_id, yet
-- transactions_recurring_occurrence below is a unique index spanning EVERY
-- wallet. Proven by the reviewer: as a non-member, inserting a transaction
-- in a DIFFERENT wallet carrying the victim's recurring_id succeeded. The
-- victim could not see that row (RLS scopes by wallet_id), and their own
-- Record then failed forever with a raw 23505 -- their UI queries `where
-- recurring_id = ... and deleted_at is null`, sees nothing, offers
-- "Record", and the write dies every time.
--
-- The fix is the COMPOSITE FK below, resting on recurring_rules_id_wallet
-- (above): a transaction's recurring_id and wallet_id must together match a
-- real (id, wallet_id) pair on recurring_rules, so an occurrence can only
-- ever be recorded into the rule's own wallet. `on delete set null
-- (recurring_id)` -- the column-list form of SET NULL, PostgreSQL 15+ -- is
-- required here rather than the bare `on delete set null`: a composite FK's
-- default SET NULL nulls EVERY referencing column, and wallet_id is NOT
-- NULL on this table, so the bare form would raise a not-null violation the
-- moment a rule with recorded occurrences was deleted. Naming just
-- recurring_id preserves the exact safety property the plain FK had (Fix 5
-- adds a constraint test for it) while the composite shape closes the
-- squatting hole. MATCH SIMPLE (the default) still skips the check
-- entirely when recurring_id is null, which is what ordinary manual
-- transactions need.
alter table transactions
  add column recurring_id uuid,
  add constraint transactions_recurring_same_wallet
    foreign key (recurring_id, wallet_id) references recurring_rules (id, wallet_id)
    on delete set null (recurring_id);

-- Fix 7 (review round 1, MINOR, comment only) -- 0004_rls.sql's column-
-- scoped UPDATE grant on transactions (kind, amount_minor, currency_code,
-- category_id, occurred_on, note, deleted_at, updated_at) does not list
-- recurring_id, so `authenticated` can INSERT it (full-table INSERT grant)
-- but can never UPDATE it. That is correct, and it partially limits Fix 3's
-- exposure above -- a row's recurring_id can't be reassigned after the
-- fact, only set once at insert time -- but this migration never mentioned
-- it, and a future migration widening that grant to include recurring_id
-- would silently reopen a smaller version of the same squatting shape this
-- fix just closed. Read 0004's own comment before adding it there.

-- Makes Record idempotent: a double tap, a retried request, or two tabs
-- cannot produce two rent rows for 1 July. Partial on deleted_at so that
-- deleting a recorded occurrence genuinely frees it to be recorded again.
create unique index transactions_recurring_occurrence
  on transactions (recurring_id, occurred_on)
  where recurring_id is not null and deleted_at is null;

-- Fix 6 (review round 1, MINOR) -- a plain index on recurring_id. The only
-- other index touching this column is the partial unique one just above,
-- whose predicate excludes soft-deleted rows, so it cannot serve
-- transactions_recurring_same_wallet's ON DELETE SET NULL scan (which must
-- walk every transaction pointing at a deleted rule, deleted_at or not) --
-- `explain (costs off)` on that delete shows a Seq Scan on transactions
-- without this index. 0003 added transactions_category for exactly this
-- reason on the sibling category FK.
create index transactions_recurring on transactions (recurring_id);

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

-- Fix 1 (review round 1, CRITICAL) -- the blanket UPDATE grant above
-- includes wallet_id and created_by, which let a co-member steal a rule.
-- recurring_rules_member (below) is `for all using (is_wallet_member
-- (wallet_id)) with check (is_wallet_member(wallet_id))`: on UPDATE,
-- `using` sees the OLD row and `with check` sees the NEW one, and both ask
-- the IDENTICAL question -- so a member of two different wallets satisfies
-- both while moving a row between them. RLS cannot express "wallet_id must
-- not change" (`with check` has no access to the old row to compare
-- against). Proven live by the reviewer, running as a co-member (not the
-- owner): `update recurring_rules set wallet_id = <co-member's other
-- wallet> where id = <victim's rule>` succeeded, and recurring_skips'
-- ON DELETE CASCADE FK meant the victim then lost the rule AND its whole
-- skip history, with no audit trail and no route to recover it. The same
-- grant also let a co-member rewrite created_by to themselves.
--
-- This is the EXACT hole 0004_rls.sql's own long comment documents for
-- transactions, and 0012_budgets.sql's comment repeats for budgets --
-- column-level privilege, evaluated before RLS even runs, is the only
-- mechanism that can close it: narrow the blanket UPDATE grant to the
-- columns this feature actually needs to edit.
--
-- wallet_id and created_by are DELIBERATELY absent from the list below --
-- moving a rule between wallets, or re-attributing it to another user, is
-- not a feature this migration builds. Read 0004_rls.sql's UPDATE-grant
-- comment (the argument this fix applies verbatim) before widening this
-- list.
revoke update on recurring_rules from authenticated;
grant update (name, kind, amount_minor, currency_code, category_id,
              interval_unit, anchor_on, ends_on, archived_at, updated_at)
  on recurring_rules to authenticated;

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
--
-- Fix 7 (review round 1, MINOR, comment only) -- a side effect of this
-- shape, correct by design but previously undocumented: inserting a skip
-- for a rule_id that does not exist AT ALL returns 42501
-- insufficient_privilege (this WITH CHECK's exists-subquery finds no row,
-- member or not, and fails first) rather than 23503 foreign_key_violation
-- (recurring_skips' own `rule_id references recurring_rules(id)`). WITH
-- CHECK is evaluated before the FK is ever reached, so there is no
-- existence oracle here -- a caller cannot distinguish "no such rule" from
-- "a real rule I'm not a member of" by error code; both come back 42501.
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
