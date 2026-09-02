# Editable transactions, and a merchant field — design

**Status:** APPROVED 2026-09-02.

**Goal:** let a user correct any transaction they have already recorded, and
record who they paid as a field of its own rather than folding it into the note.

---

## 1. The decisions, and why

### 1.1 Every transaction is editable, including transfers and recorded occurrences

The user asked for this explicitly. It is the requirement that forces §1.2 —
without it, the two special cases could simply have been excluded.

### 1.2 A recorded occurrence's SCHEDULED date and its ACTUAL date become
different columns

Today a recorded recurring occurrence is identified by
`(recurring_id, occurred_on)` — the partial unique index from
`0015_recurring.sql`. That conflates two different facts into one column:

- **which occurrence this satisfies** (1 July's rent), and
- **when the money actually moved** (you paid on the 3rd).

While transactions could not be edited, the conflation was invisible. Making
them editable exposes it: correcting the date from 1 July to 3 July would make
1 July **un-recorded** — it reappears on the dashboard as due — while 3 July
becomes "recorded" for an occurrence that does not exist. The user paid their
rent and the app would ask them to pay it again.

So `transactions` gains `recurring_occurrence_on`, the scheduled date, and the
unique index moves onto it. `occurred_on` becomes free to edit and means only
what it says.

This was recorded as a known deferred item during the recurring work (Task 2's
review, M2), justified at the time by "there is no `updateTransaction` action —
direct-POST only". That justification expires with this feature.

### 1.3 A transfer is edited as a pair, never as one leg

A transfer is two rows sharing a `transfer_id`, with opposite signs and no
category (`0003_transactions.sql`'s `transfer_shape` CHECK). Editing one leg's
amount alone would make money appear or vanish.

Editing either leg therefore updates both, atomically, in a single statement
scoped by `transfer_id`. The UI states that it is editing both.

### 1.4 A transaction cannot change wallets

`0004_rls.sql:83` grants UPDATE on a named column list that deliberately
excludes `wallet_id`, for the reason that file documents at length: `USING`
sees the old row and `WITH CHECK` the new one, so a member of two wallets
satisfies both while moving a row out of one. The same reasoning closed a
proven privilege escalation on `recurring_rules` in `0015`.

Moving money between wallets is a transfer, not an edit. This spec does not
widen that grant.

### 1.5 Any wallet member may edit

Consistent with creating and deleting. `transactions_member`,
`categories_member` and `budgets_member` all say the same thing: members are
equal on ledger content, and owner-only is reserved for membership and for
archiving a wallet.

### 1.6 Merchant is stored and shown, NOT searchable

There is no search on `/transactions` — `/wallets` has one, this screen does
not. Adding a search is a separate feature and is out of scope here.

---

## 2. Data model

```sql
alter table transactions
  add column merchant text check (merchant is null or length(merchant) <= 120),
  add column recurring_occurrence_on date;

-- Backfill before the index moves: every existing recorded occurrence keeps
-- the identity it already had. Expected to affect zero rows (the recurring
-- feature shipped the same day) but written rather than assumed.
update transactions
   set recurring_occurrence_on = occurred_on
 where recurring_id is not null and recurring_occurrence_on is null;

-- The identity is the SCHEDULED date, not the actual one.
drop index transactions_recurring_occurrence;
create unique index transactions_recurring_occurrence
  on transactions (recurring_id, recurring_occurrence_on)
  where recurring_id is not null and deleted_at is null;

-- One direction only: a recurring_id must carry a scheduled date, because
-- without one it has no identity.
--
-- The reverse is deliberately NOT constrained, and a symmetric
-- `(recurring_id is null) = (recurring_occurrence_on is null)` would be a
-- bug. `recurring_id` is `ON DELETE SET NULL` (0015 §2.3) precisely so that
-- deleting a rule never deletes money already spent — that DELETE nulls
-- `recurring_id` and leaves `recurring_occurrence_on` set, which a symmetric
-- check would reject, making the rule undeletable and destroying the safety
-- property the SET NULL exists for. A transaction orphaned from its rule
-- keeps a harmless record of which occurrence it once satisfied.
alter table transactions
  add constraint recurring_occurrence_needs_rule
  check (recurring_id is null or recurring_occurrence_on is not null);

grant update (merchant) on transactions to authenticated;
```

`recurring_occurrence_on` is deliberately **not** in the UPDATE grant. It is
the occurrence's identity, set once at Record time; a user editing a
transaction must not be able to reassign which occurrence it satisfies. Only
`merchant` joins the existing editable list.

`120` for merchant against `note`'s `280`: a merchant is a name, not a
sentence.

---

## 3. Editing semantics

### 3.1 What each kind exposes

| Kind | Editable | Fixed, and why |
|---|---|---|
| expense / income | amount, date, category, note, merchant | wallet (§1.4), currency (FK ties it to the wallet), kind |
| transfer | amount, date, note, merchant — **on both legs** | category (CHECK forbids it), wallets, currency, kind |
| recorded occurrence | as its kind above | additionally `recurring_occurrence_on`, which is its identity |

`kind` is not editable. Changing an expense into income would have to flip the
amount's sign to satisfy `expense_is_negative` / `income_is_positive`, and
changing either into a transfer is meaningless without a second wallet and a
paired row. Deleting and re-creating is the honest path, and it already exists.

### 3.2 The transfer pair

One statement, scoped `where transfer_id = $1 and deleted_at is null`:

- **date, note, merchant** — set identically on both rows.
- **amount** — `case when amount_minor < 0 then -$new else $new end`, so the
  outgoing leg stays negative and the incoming leg stays positive.

Both legs are always in wallets the caller is a member of, or the transfer
could not have been created — but the UPDATE is RLS-scoped regardless, so a
pair straddling a wallet the caller has since lost access to updates neither
leg rather than one.

### 3.3 Validation

`updateTransaction` re-validates exactly what `createTransaction` does, for the
same reason: a Server Function is reachable by direct POST regardless of what
the form offers.

- the wallet is active (`transactions.ts:104`'s existing check);
- the category's kind matches the transaction's kind and the category is not
  archived (`:147`);
- the category belongs to the transaction's own wallet (the composite FK
  enforces it, but a readable message beats a driver error);
- the amount is non-zero and correctly signed for its kind;
- a transfer's edit carries no category.

Returns `{ error }`, never throws — Next replaces thrown server errors with an
opaque digest in production.

---

## 4. Merchant in the UI

`TransactionList`'s `rowLabel` currently resolves note → category. It becomes
**merchant → note → category**, and the note joins the secondary line beside
the category, exactly as the category already demotes today.

This is additive: a row with no merchant renders precisely as it does now. Only
rows that gain a merchant change.

The delete toast and the row's Delete `aria-label` follow `rowLabel`, so they
inherit this automatically — and must, or a row would announce one name and its
delete button another.

---

## 5. Surfaces

- **The transaction row becomes the edit entry point.** Tapping it opens the
  edit form. The row's existing Delete control stays where it is.
- **`TransactionForm` gains an edit mode**, the way `WalletForm` did: seeded
  from the transaction, submitting to `updateTransaction`, with the fixed
  fields rendered as stated values rather than disabled controls — this
  codebase's convention for a control that can never succeed.
- **A transfer's edit form says it is editing both legs**, and shows the two
  wallets.

---

## 6. Out of scope

- **Search on `/transactions`** (§1.6).
- **Merchant autocomplete** from past merchants. Worth having; a separate
  feature.
- **Merchant-driven category defaults** ("Tesco" implies Groceries).
- **Changing a transaction's wallet or kind** (§1.4, §3.1).
- **An edit history or audit trail.** `updated_at` moves; nothing records what
  changed.
- **Editing a deleted transaction.** Restore it first.

---

## 7. Testing

- **Constraints, SQL** — the `recurring_occurrence_needs_rule` CHECK rejects a
  `recurring_id` with no scheduled date, AND — the case that matters —
  deleting a rule with recorded occurrences still SUCCEEDS, leaving
  `recurring_occurrence_on` set and `recurring_id` null. A symmetric check
  would have made that delete fail; the moved unique index still refuses two live recordings of one
  occurrence and still frees it after a soft delete; `merchant`'s length cap
  fires; and the backfill sets what it should.
- **RLS, SQL** — a non-member cannot update a transaction; a co-member can.
- **Action, unit** — the payload never contains `wallet_id` or
  `recurring_occurrence_on`; each validation above rejects with a readable
  message; a zero-row UPDATE reports "not found" rather than success.
- **The transfer pair** — editing one leg's amount leaves both legs opposite
  and equal in magnitude; editing the date moves both. **This is the assertion
  most worth having**: a test that only checks the edited leg would pass while
  the ledger silently gained or lost money.
- **The recurring identity** — editing a recorded occurrence's `occurred_on`
  does NOT return it to the due list. Equally load-bearing: it is the whole
  reason §1.2 exists, and a test that only checks the transaction's new date
  would pass with the bug intact.
- **E2E** — edit an expense's amount and see the balance follow; edit a
  transfer and see both legs move; edit a recorded occurrence's date and
  confirm the dashboard does not offer it again.

---

## 8. Open questions

None. §1.1 was the user's explicit requirement; §1.2 through §1.6 follow from
it or from existing codebase convention.
