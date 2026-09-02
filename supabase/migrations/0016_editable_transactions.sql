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

-- Task 4: editing a transfer, both legs together. update_transfer_pair is
-- the UPDATE-side counterpart to create_transfer (0005_transfer_fn.sql),
-- solving the identical atomicity problem: a transfer is two rows sharing
-- transfer_id with opposite-signed amount_minor
-- (0003_transactions.sql's transfer_shape/non_transfer_no_link CHECKs), so
-- editing one leg's amount without the other makes money appear or vanish.
-- PostgREST cannot express a `CASE` inside a single client-side `.update()`
-- call, and two separate client-side `.update()` calls are two separate
-- HTTP requests -- not atomic, so a failure between them would leave a
-- half-updated pair. Wrapping both writes in one PL/pgSQL statement makes
-- them one Postgres transaction, exactly like create_transfer's own two
-- INSERTs. See src/server/actions/transactions.ts's updateTransfer doc
-- comment and this task's report for the full reasoning.
--
-- p_amount_out/p_amount_in (task-4 fix round 1 -- originally a single
-- shared p_amount; see transferEditInput's own doc comment in
-- src/lib/validation/transaction.ts for why that was a defect). Mirrors
-- create_transfer's own amount_out/amount_in exactly, for the identical
-- reason: a cross-currency transfer's two legs are genuinely different
-- amounts in different currencies, and a single shared magnitude cannot
-- represent that. Each row's EXISTING sign (read from the row itself,
-- never from an argument) decides which side of the pair it lands on --
-- the outgoing leg (already negative) gets -p_amount_out, the incoming leg
-- (already positive) gets +p_amount_in. A row can never change which side
-- it's on through this function: there is no argument that identifies
-- "the outgoing leg" for a caller to get backwards, only the CASE reading
-- the row's own current sign.
--
-- The same-currency balance invariant lives HERE, not in
-- transferEditInput/updateTransfer, exactly the way create_transfer is the
-- one place that enforces it for creation -- both legs' CURRENT
-- currency_code (already fixed at creation time; this function never
-- changes it) decide whether the check applies, read from the rows
-- themselves rather than trusted from an argument, the same "never trust
-- the caller for something the row already knows" discipline the sign CASE
-- above follows.
--
-- security invoker, like create_transfer, and for the identical reason:
-- this must run under the CALLER's own transactions_member RLS (`for all
-- using (is_wallet_member(wallet_id)) with check (is_wallet_member(wallet_id))`)
-- and column-scoped UPDATE grant (0004_rls.sql, extended above), not with
-- elevated rights. A caller who is a member of only one of the transfer's
-- two wallets (membership can change after a transfer is created) sees
-- only one row here, exactly like a genuinely missing transfer_id would --
-- there is no privilege this function grants to reach the other leg, and
-- updateTransfer's own exactly-two-rows check turns that into a readable
-- "not found" rather than a silent single-leg write. supabase/tests/rls.sql
-- carries the adversarial coverage for this (a non-member is refused, a
-- member succeeds), mirroring create_transfer's own coverage there.
--
-- search_path is set to '' (0004/0005's convention), so every reference
-- below is schema-qualified.
create function update_transfer_pair(
  p_transfer_id uuid,
  p_amount_out bigint,
  p_amount_in bigint,
  p_occurred_on date,
  p_note text default null,
  p_merchant text default null
) returns setof transactions
  language plpgsql security invoker set search_path = '' as $$
declare
  out_ccy char(3);
  in_ccy  char(3);
begin
  -- Same reasoning as create_transfer's identical null/positivity checks,
  -- and the identical message text (both already sit in
  -- src/server/actions/transactions.ts's KNOWN_TRANSFER_ERRORS allowlist,
  -- so no change was needed there to forward these verbatim): a plpgsql
  -- parameter list can't carry `not null`, so an explicit JSON null for
  -- either amount or the date would otherwise fall through to the UPDATE
  -- below and die on a NOT NULL column constraint instead of this
  -- function's own message.
  if p_amount_out is null or p_amount_in is null or p_occurred_on is null then
    raise exception 'transfer amounts and date must not be null';
  end if;
  if p_amount_out <= 0 or p_amount_in <= 0 then
    raise exception 'transfer amounts must be positive';
  end if;

  -- Read each leg's CURRENT currency directly off the rows -- not passed
  -- in by the caller, and not assumed from wallet_id (the rows already
  -- carry their own currency_code, fixed at creation time). `limit 1`
  -- (ordered, not `select ... into strict`) is deliberate: the schema has
  -- no CHECK enforcing that a transfer's two legs actually carry opposite
  -- signs (0003_transactions.sql's transfer_shape only requires
  -- category_id null and transfer_id set), so a malformed pair -- however
  -- it got that way -- must not raise an unhandled "more than one row"
  -- error here. Absent (RLS-filtered, soft-deleted, or genuinely missing)
  -- leaves the variable NULL rather than erroring, which the check right
  -- below turns into "incomplete pair" instead of a crash.
  select currency_code into out_ccy from public.transactions
    where transfer_id = p_transfer_id and amount_minor < 0 and deleted_at is null
    order by created_at limit 1;
  select currency_code into in_ccy from public.transactions
    where transfer_id = p_transfer_id and amount_minor > 0 and deleted_at is null
    order by created_at limit 1;

  -- Incomplete pair (missing transfer_id, RLS hid a leg the caller isn't a
  -- member of, or a malformed same-signed pair) -- return the empty set
  -- rather than raising, so updateTransfer's own exactly-two-rows check
  -- reports it as "not found" the same uniform way a missing row anywhere
  -- else in this app is reported, not a distinct Postgres exception
  -- message a caller would have to special-case.
  if out_ccy is null or in_ccy is null then
    return;
  end if;

  -- The identical rule create_transfer enforces on creation, applied again
  -- on edit for the same reason: when both legs are in the same currency
  -- there is no exchange rate to justify amount_out <> amount_in -- that
  -- would either destroy money (out > in) or fabricate it (out < in) with
  -- no error and no record. A cross-currency pair keeps two independent
  -- amounts, since a real exchange rate applies there.
  if out_ccy = in_ccy and p_amount_out <> p_amount_in then
    raise exception 'a same-currency transfer must balance';
  end if;

  return query
    update public.transactions
       set amount_minor = case when amount_minor < 0 then -p_amount_out else p_amount_in end,
           occurred_on  = p_occurred_on,
           note         = p_note,
           merchant     = p_merchant,
           updated_at   = now()
     where transfer_id = p_transfer_id
       and deleted_at is null
     returning *;
end $$;

grant execute on function update_transfer_pair(uuid, bigint, bigint, date, text, text) to authenticated;
