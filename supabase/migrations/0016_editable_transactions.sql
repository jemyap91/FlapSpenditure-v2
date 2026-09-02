-- supabase/migrations/0016_editable_transactions.sql
--
-- Editable transactions and a merchant field (spec
-- 2026-09-02-editable-transactions-design).
--
-- The substantive change is splitting one column into two facts. A recorded
-- recurring occurrence was identified by (recurring_id, occurred_on), which
-- conflates WHICH occurrence a transaction satisfies with WHEN the money
-- actually moved. That was invisible while transactions could not be edited;
-- making them editable exposes it, because correcting a date from 1 July to
-- 3 July would make 1 July un-recorded -- the dashboard would ask the user to
-- pay rent they had already paid.

alter table transactions
  add column merchant text
    check (merchant is null or length(merchant) <= 120),
  add column recurring_occurrence_on date;

-- Backfill BEFORE the index moves, so every existing recorded occurrence keeps
-- the identity it already had. Expected to affect zero rows (0015 shipped the
-- same day) -- written rather than assumed, because a migration that is
-- correct only on an empty table is a migration that fails in production.
update transactions
   set recurring_occurrence_on = occurred_on
 where recurring_id is not null and recurring_occurrence_on is null;

-- The identity is the SCHEDULED date, not the actual one.
drop index transactions_recurring_occurrence;
create unique index transactions_recurring_occurrence
  on transactions (recurring_id, recurring_occurrence_on)
  where recurring_id is not null and deleted_at is null;

-- One direction only. A symmetric
-- `(recurring_id is null) = (recurring_occurrence_on is null)` would be a BUG:
-- recurring_id is ON DELETE SET NULL (0015) precisely so deleting a rule never
-- deletes money already spent, and that DELETE leaves recurring_occurrence_on
-- set while nulling recurring_id. A symmetric check would reject it, making
-- the rule undeletable and destroying the property the SET NULL exists for.
alter table transactions
  add constraint recurring_occurrence_needs_rule
  check (recurring_id is null or recurring_occurrence_on is not null);

-- merchant joins the existing editable column list (0004_rls.sql:83).
-- recurring_occurrence_on deliberately does NOT: it is an occurrence's
-- identity, and this UPDATE grant is what stops a user's EDIT of an existing
-- transaction from reassigning which occurrence it satisfies. That is
-- narrower than "set once at Record time" -- INSERT and DELETE on
-- transactions are still plain table-level grants (0004_rls.sql), not
-- column-scoped, so a caller can still delete a recorded row and insert a
-- replacement carrying a different recurring_occurrence_on for the same
-- rule. That is not a privilege escalation (RLS still confines it to the
-- caller's own wallet, and it is the exact recorded-money-stays-safe shape
-- 0015's ON DELETE SET NULL and this migration's own one-directional CHECK
-- both already accept), so it is left as is rather than closed here; the
-- guarantee this grant actually provides is only about UPDATE.
grant update (merchant) on transactions to authenticated;
