# Editable Transactions & Merchant Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** let a user correct any transaction they have recorded — including
transfers and occurrences recorded from a recurring rule — and record who they
paid in a field of its own.

**Architecture:** one migration adds `merchant` and `recurring_occurrence_on`
and moves the recurring identity index onto the scheduled date, so a
transaction's actual date becomes free to edit. A new `updateTransaction`
server action re-validates everything `createTransaction` does; transfers
update both legs in one statement with each leg's sign preserved.
`TransactionForm` gains an edit mode reached by tapping a row.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres with RLS, TypeScript
strict, Tailwind, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-02-editable-transactions-design.md`

## Global Constraints

- **Migration number is `0016`.** `0014_rls_initplan.sql` is unmerged on branch
  `worktree-perf`; `0015` is the recurring feature. Do not renumber either.
- **Never widen the UPDATE grant beyond `merchant`.** `0004_rls.sql:83` grants
  UPDATE on a named column list that deliberately excludes `wallet_id`, because
  `USING` sees the old row and `WITH CHECK` the new one — so a member of two
  wallets satisfies both while moving a row out of one. The same reasoning
  closed a proven privilege escalation on `recurring_rules` in `0015`.
  `recurring_occurrence_on` is likewise NOT granted: it is an occurrence's
  identity, not user data.
- **Money is bigint minor units end-to-end.** Never `parseFloat(x) * 100`.
  `parseAmountInput` / `formatAmountInput` in `src/lib/money.ts` are the only
  conversions.
- **Sign follows kind:** expense negative, income positive, matching
  `0003_transactions.sql`'s `expense_is_negative` / `income_is_positive`.
- **Never construct a `Date` from local components for calendar arithmetic.**
  `src/lib/month-range.ts` documents a shipped Critical bug. Use
  `src/lib/today.ts` for "today"; there is exactly one definition and it must
  stay that way.
- **Server Functions return `{ error }`, never throw** user-facing text. Next
  replaces thrown server errors with an opaque digest in production.
- **RLS scopes through `is_wallet_member(wallet_id)`** — the project's single
  membership predicate (`supabase/migrations/0004_rls.sql:13`).
- **Say "wallet", never "account"**, when a wallet is meant.
- **SQL test suites are loopback-only.** `npm run test:rls` and
  `npm run test:constraints` must never target a hosted database.
- **After ANY schema change, run the e2e suite in the same task.** A foreign
  key added during the recurring work made an existing PostgREST embed
  ambiguous and broke `/transactions` for every user; it shipped undetected for
  three tasks because no unit test can see it.

---

### Task 1: Schema, constraints and RLS

**Files:**
- Create: `supabase/migrations/0016_editable_transactions.sql`
- Modify: `supabase/tests/constraints.sql`, `supabase/tests/rls.sql`

**Interfaces:**
- Consumes: `transactions` and its `transactions_recurring_occurrence` index
  from `0015_recurring.sql`; `is_wallet_member(uuid)` from `0004_rls.sql`.
- Produces: columns `transactions.merchant` and
  `transactions.recurring_occurrence_on`; the moved unique index; the
  `recurring_occurrence_needs_rule` CHECK.

- [ ] **Step 1: Write the migration**

```sql
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
-- identity, set once at Record time, and a user editing a transaction must not
-- be able to reassign which occurrence it satisfies.
grant update (merchant) on transactions to authenticated;
```

- [ ] **Step 2: Apply it**

Run: `npx supabase db reset`
Expected: completes with no error, applying `0016_editable_transactions.sql`
last.

- [ ] **Step 3: Add constraint tests**

Append to `supabase/tests/constraints.sql`, matching that file's existing
convention — literal UUIDs, inline fixture inserts inside `do $$ ... $$`
blocks, and an `exception when` clause asserting the SPECIFIC constraint name
via `get stacked diagnostics`. Read the file first; do not invent helpers.

Required assertions:

1. **`merchant`'s length cap fires** at 121 characters, naming the check.
2. **`recurring_occurrence_needs_rule` rejects** a row with `recurring_id` set
   and `recurring_occurrence_on` null.
3. **Deleting a rule with recorded occurrences still SUCCEEDS**, leaving
   `recurring_id` null and `recurring_occurrence_on` set. This is the case a
   symmetric CHECK would have broken; it is the most important assertion in
   this task.
4. **The moved index still refuses** two live transactions for one
   `(recurring_id, recurring_occurrence_on)`, and still frees the slot after a
   soft delete.
5. **Two recorded occurrences of one rule may now share an `occurred_on`** —
   the whole point of the split. Record 1 July and 1 August, then edit both to
   fall on 15 August: both persist, because their identities differ.

- [ ] **Step 4: Add an RLS test**

Append to `supabase/tests/rls.sql`, following its `set local role authenticated`
plus `set local request.jwt.claims` convention and reusing its existing
fixtures. Required outcomes:

- a NON-member's `update transactions set merchant = ...` affects **zero rows**;
- a **co-member's** update of a shared wallet's transaction **succeeds** — the
  load-bearing half, because a suite that only proves a stranger is blocked
  cannot tell a correct policy from one that denies everybody;
- a member's attempt to `update transactions set wallet_id = ...` is
  **refused** (the column is not granted). Verify this assertion discriminates
  by temporarily granting the column, confirming the test fails, and reverting.

- [ ] **Step 5: Run every suite**

Run: `npm run test:constraints && npm run test:rls && npm test && npx playwright test`
Expected: all pass. The e2e run is required by this plan's global constraints
because this task changes the schema.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0016_editable_transactions.sql supabase/tests
git commit -m "feat(db): add merchant, split the recurring occurrence identity from the actual date

A recorded occurrence was identified by (recurring_id, occurred_on), which
conflated which occurrence a transaction satisfies with when the money moved.
Editing a date would have made an already-paid occurrence due again."
```

---

### Task 2: Validation

**Files:**
- Modify: `src/lib/validation/transaction.ts`, `src/lib/validation/transaction.test.ts`

**Interfaces:**
- Consumes: the existing `transactionInput` (`transaction.ts:130`) and
  `transferInput` (`:144`).
- Produces:
  ```ts
  export const transactionEditInput: z.ZodType<TransactionEditInput>;
  export type TransactionEditInput = {
    id: string;
    amount: string;
    occurred_on: string;
    category_id: string | null;
    note: string | null;
    merchant: string | null;
  };
  export const transferEditInput: z.ZodType<TransferEditInput>;
  export type TransferEditInput = {
    transfer_id: string;
    amount: string;
    occurred_on: string;
    note: string | null;
    merchant: string | null;
  };
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe("transactionEditInput", () => {
  it("accepts a well-formed edit", () => {
    expect(transactionEditInput.safeParse(baseEdit).success).toBe(true);
  });

  it("coerces an empty merchant to null, like note", () => {
    // "" must not be stored: `merchantOf`/`noteOf` in TransactionList treat a
    // blank string as absent, and storing one would give a row an empty
    // heading rather than falling back to the category.
    expect(transactionEditInput.parse({ ...baseEdit, merchant: "" }).merchant).toBeNull();
  });

  it("refuses a merchant over 120 characters", () => {
    const r = transactionEditInput.safeParse({ ...baseEdit, merchant: "x".repeat(121) });
    expect(r.success).toBe(false);
  });

  it("refuses a malformed date", () => {
    // z.iso.date(), never a bare regex: a regex accepts 2026-02-30, which
    // reaches Postgres as a driver error instead of a readable message.
    expect(transactionEditInput.safeParse({ ...baseEdit, occurred_on: "2026-02-30" }).success)
      .toBe(false);
  });

  it("carries no wallet_id or kind — neither is editable", () => {
    const parsed = transactionEditInput.parse({ ...baseEdit, wallet_id: "x", kind: "income" } as never);
    expect(parsed).not.toHaveProperty("wallet_id");
    expect(parsed).not.toHaveProperty("kind");
  });
});

describe("transferEditInput", () => {
  it("carries no category — a transfer cannot have one", () => {
    // 0003's transfer_shape CHECK forces category_id null on a transfer, so a
    // schema that accepted one would produce a database error rather than a
    // message.
    const parsed = transferEditInput.parse({ ...baseTransferEdit, category_id: "x" } as never);
    expect(parsed).not.toHaveProperty("category_id");
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/lib/validation/transaction.test.ts`
Expected: FAIL — `transactionEditInput` is not exported.

- [ ] **Step 3: Implement**

Model both on the existing `transactionInput`/`transferInput` in the same file
— reuse its amount, date and note handling rather than writing a second
version. `merchant` mirrors `note`'s treatment exactly (trimmed, `""` → null)
with a 120-character cap. Neither edit schema declares `wallet_id` or `kind`:
absent from the schema means absent from the parsed payload, which is what
keeps them out of the UPDATE.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/lib/validation/transaction.test.ts && npm run typecheck`
Expected: PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/transaction.ts src/lib/validation/transaction.test.ts
git commit -m "feat: validate transaction edits"
```

---

### Task 3: `updateTransaction` for ordinary transactions

**Files:**
- Modify: `src/server/actions/transactions.ts`, `src/server/actions/transactions.test.ts`

**Interfaces:**
- Consumes: `transactionEditInput` (Task 2).
- Produces:
  ```ts
  export async function updateTransaction(input: TransactionEditInput): Promise<MutationResult>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("never writes wallet_id, kind, or recurring_occurrence_on", async () => {
  // The grant excludes all three. wallet_id would let a member of two wallets
  // move a row out of one (0004_rls.sql:83's own reasoning);
  // recurring_occurrence_on is an occurrence's identity, not user data.
  await updateTransaction(edit());
  const payload = updateSpy.mock.calls[0]![0];
  expect(payload).not.toHaveProperty("wallet_id");
  expect(payload).not.toHaveProperty("kind");
  expect(payload).not.toHaveProperty("recurring_occurrence_on");
});

it("scopes the UPDATE to the row's own id", async () => {
  await updateTransaction(edit());
  expect(eqSpy).toHaveBeenCalledWith("id", TXN_ID);
});

it("refuses an archived wallet", async () => {
  walletRow.archived_at = "2026-06-01T00:00:00Z";
  expect((await updateTransaction(edit())).error).toMatch(/archived/i);
  expect(updateSpy).not.toHaveBeenCalled();
});

it("refuses a category whose kind does not match", async () => {
  categoryRow.kind = "income";
  expect((await updateTransaction(edit())).error).toMatch(/doesn't match/i);
});

it("reports not found rather than success when the UPDATE matches no row", async () => {
  updateResult.data = [];
  expect(await updateTransaction(edit())).toEqual({ error: "Transaction not found" });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/server/actions/transactions.test.ts`
Expected: FAIL — `updateTransaction is not a function`.

- [ ] **Step 3: Implement**

Follow `createTransaction` in the same file for shape and for every check it
makes — the wallet is active (`:104`), the category's kind matches and it is
not archived (`:147`), the amount is non-zero with the sign its kind requires.
Load the row first to learn its `wallet_id` and `kind`; never trust a posted
one. Select the affected ids back and treat an empty result as "not found", the
way `archiveWallet` and `archiveCategory` do — a zero-row UPDATE is not an
error in Postgres and would otherwise be reported to the user as success.

`revalidatePath("/", "layout")`.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/server/actions/transactions.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the id scoping discriminates**

Temporarily delete `.eq("id", id)` from the UPDATE. Re-run; the scoping test
must FAIL. Restore and confirm green. Paste both outputs into your report — an
UPDATE with no `WHERE` would rewrite every transaction RLS lets the caller see,
and a suite that cannot notice that is the specific gap this step exists to
close.

- [ ] **Step 6: Commit**

```bash
git add src/server/actions/transactions.ts src/server/actions/transactions.test.ts
git commit -m "feat: edit an ordinary transaction"
```

---

### Task 4: Editing a transfer, both legs together

**Files:**
- Modify: `src/server/actions/transactions.ts`, `src/server/actions/transactions.test.ts`

**Interfaces:**
- Consumes: `transferEditInput` (Task 2).
- Produces:
  ```ts
  export async function updateTransfer(input: TransferEditInput): Promise<MutationResult>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("updates BOTH legs, keeping their signs opposite", async () => {
  // THE assertion for this task. A transfer is two rows sharing a
  // transfer_id; editing one leg's amount alone makes money appear or vanish.
  await updateTransfer(transferEdit({ amount: "25.00" }));
  const rows = updateResult.data!;
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.amount_minor).sort((a, b) => a - b)).toEqual([-2500, 2500]);
});

it("scopes the UPDATE by transfer_id, not by row id", async () => {
  await updateTransfer(transferEdit());
  expect(eqSpy).toHaveBeenCalledWith("transfer_id", TRANSFER_ID);
});

it("reports not found when the pair is incomplete", async () => {
  // A pair that updates one leg is worse than one that updates neither.
  updateResult.data = [{ id: "a" }];
  expect((await updateTransfer(transferEdit())).error).toMatch(/not found|both/i);
});

it("never writes a category onto a transfer", async () => {
  await updateTransfer(transferEdit());
  expect(updateSpy.mock.calls[0]![0]).not.toHaveProperty("category_id");
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/server/actions/transactions.test.ts`
Expected: FAIL — `updateTransfer is not a function`.

- [ ] **Step 3: Implement**

One UPDATE scoped `where transfer_id = $1 and deleted_at is null`. Date, note
and merchant are set identically on both rows. The amount preserves each leg's
sign — expressed so that the outgoing leg stays negative and the incoming leg
stays positive; PostgREST cannot express a `CASE`, so this needs an RPC in the
migration OR two scoped updates inside one action. If you choose two updates,
say in your report how a partial failure is handled, because two statements are
not atomic and a half-updated transfer is exactly the corruption this task
exists to prevent. Read `supabase/migrations/0005_transfer_fn.sql`'s
`create_transfer` first — it solved the same atomicity problem for creation and
is the precedent.

Select both ids back and require exactly two rows.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/server/actions/transactions.test.ts && npm run test:constraints`
Expected: PASS.

- [ ] **Step 5: Prove the pair assertion discriminates**

Temporarily make the update touch only the leg whose `id` was passed. Re-run;
the both-legs test must FAIL. Restore, confirm green, paste both outputs.

- [ ] **Step 6: Commit**

```bash
git add src/server/actions/transactions.ts src/server/actions/transactions.test.ts supabase/migrations
git commit -m "feat: edit a transfer as a pair, preserving each leg's sign"
```

---

### Task 5: Merchant in the list

**Files:**
- Modify: `src/components/TransactionList.tsx`, `src/components/TransactionList.test.tsx`
- Modify: `src/app/(app)/transactions/page.tsx`, `src/app/(app)/wallets/[id]/page.tsx`

**Interfaces:**
- Consumes: the `merchant` column (Task 1).
- Produces: `Row` gains `merchant: string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
it("uses the merchant as the row's primary line when present", () => {
  render(<TransactionList rows={[row({ merchant: "Tesco", note: "weekly shop" })]} />);
  expect(screen.getByText("Tesco")).toBeInTheDocument();
});

it("demotes the note beside the category when a merchant is present", () => {
  render(<TransactionList rows={[row({ merchant: "Tesco", note: "weekly shop", category_name: "Groceries" })]} />);
  expect(screen.getByText(/weekly shop/)).toBeInTheDocument();
  expect(screen.getByText(/Groceries/)).toBeInTheDocument();
});

it("falls back to the note exactly as before when there is no merchant", () => {
  // Additive: a row with no merchant must render precisely as it does today.
  render(<TransactionList rows={[row({ merchant: null, note: "weekly shop" })]} />);
  expect(screen.getByText("weekly shop")).toBeInTheDocument();
});

it("treats a blank merchant as absent", () => {
  render(<TransactionList rows={[row({ merchant: "   ", note: "weekly shop" })]} />);
  expect(screen.getByText("weekly shop")).toBeInTheDocument();
});

it("names the Delete button after the merchant when there is one", () => {
  // rowLabel drives the Delete aria-label and the toast; a row that announces
  // one name and a delete button that announces another is the defect here.
  render(<TransactionList rows={[row({ merchant: "Tesco", amount_minor: -1800 })]} />);
  expect(screen.getByRole("button", { name: /Delete Tesco/ })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/components/TransactionList.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `merchant` to `Row` and a `merchantOf` helper mirroring the existing
`noteOf` (blank is absent, for the reason `noteOf` documents). `rowLabel`
becomes merchant → note → category. Add `merchant` to both pages' `select`
strings.

Update `Row.note`'s doc comment, which currently reads "Typically a merchant" —
that was true only because there was nowhere else to put one.

- [ ] **Step 4: Run and watch them pass**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/TransactionList.tsx src/components/TransactionList.test.tsx "src/app/(app)/transactions/page.tsx" "src/app/(app)/wallets/[id]/page.tsx"
git commit -m "feat: show a transaction's merchant as its primary line"
```

---

### Task 6: The edit form and its entry point

**Files:**
- Modify: `src/components/TransactionForm.tsx`, `src/components/TransactionForm.test.tsx`
- Modify: `src/components/TransactionList.tsx`, `src/components/TransactionList.test.tsx`
- Create: `src/app/(app)/transactions/[id]/edit/page.tsx` and its test

**Interfaces:**
- Consumes: `updateTransaction`, `updateTransfer` (Tasks 3-4), both returning
  `MutationResult = { ok: true } | { error: string }` (`transactions.ts:16`).

- [ ] **Step 1: Write the failing tests**

```ts
it("seeds every field from the transaction being edited", async () => { /* ... */ });

it("offers no wallet or kind control — neither is editable", () => {
  // Absent, not disabled: this codebase's convention for a control that can
  // never succeed (TransactionForm removes the category chip on a transfer;
  // WalletList renders no Archive for a non-owner).
  render(<TransactionForm mode="edit" {...editProps} />);
  expect(screen.queryByRole("combobox", { name: /Wallet/i })).not.toBeInTheDocument();
});

it("offers no category control when editing a transfer", () => { /* ... */ });

it("says it is editing both legs of a transfer", () => { /* ... */ });
```

Plus, in `TransactionList.test.tsx`: the row's primary label links to that
transaction's edit route, and the row's Delete button still works.

**Do NOT make the whole row clickable.** Each row already contains a Delete
`<button>`, and wrapping that in a link nests one interactive element inside
another — invalid HTML, and the click target becomes ambiguous. `WalletList`
already solved this exact problem: the wallet's NAME is the link, the row is
not, and Archive sits beside it. Follow that precedent — the transaction's
primary label (which after Task 5 is the merchant, note or category) becomes
the link.

That also means the link's accessible name is `rowLabel`'s output, matching
what the Delete button already announces, so a row cannot name itself one thing
to a link and another to its delete control.

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

`TransactionForm` gains an edit mode, following `WalletForm`'s precedent
(`defaults` + a lock prop). **Read `WalletForm`'s long comment about hidden
inputs first**: after a failed submission, native select and radio DOM
properties silently revert toward their defaults, so submission is routed
through hidden inputs bound to React state. This form has the same exposure.

The edit route loads the transaction RLS-scoped and 404s via the same
convention `/wallets/[id]` uses (read that page — it deliberately does not call
`notFound()`, and its comment says why).

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components "src/app/(app)/transactions"
git commit -m "feat: edit a transaction from its row"
```

---

### Task 7: End-to-end proof

**Files:**
- Modify: `e2e/ledger.spec.ts` (the `ledger` describe block)

- [ ] **Step 1: Write the spec**

Self-contained per this repo's convention — `e2e/budgets.spec.ts` documents
why. Three flows:

1. **Edit an ordinary expense.** Record one, tap the row, change the amount and
   add a merchant, save. Assert the row now leads with the merchant and the
   wallet balance followed the new amount.
2. **Edit a transfer.** Create one, edit its amount, and assert BOTH legs moved
   — the negative and the positive. A test asserting only the edited leg would
   pass while the ledger gained money from nowhere.
3. **Edit a recorded occurrence's date.** Record a due occurrence from a
   recurring rule, edit the transaction's date, and assert the dashboard does
   NOT offer that occurrence again. This is the assertion the whole schema
   split exists for.

- [ ] **Step 2: Prove flow 3 discriminates**

Temporarily revert the identity index to `(recurring_id, occurred_on)` and have
`recordOccurrence` write only `occurred_on`. Re-run; flow 3 must FAIL with the
occurrence offered again. Restore, re-run green, and paste the actual output.

- [ ] **Step 3: Run everything**

Run: `npm test && npx playwright test && npm run test:rls && npm run test:constraints && npm run typecheck && npm run lint && npm run build`

- [ ] **Step 4: Commit**

```bash
git add e2e/ledger.spec.ts
git commit -m "test(e2e): prove edits reach the ledger and an edited occurrence stays recorded"
```

---

## Self-Review

**Spec coverage.** §1.1 all editable → Tasks 3, 4, 6. §1.2 the identity split →
Task 1, proven in Task 7 flow 3. §1.3 transfer pairs → Task 4. §1.4 no wallet
change → Task 1's grant note and Task 3's payload test. §1.5 any member →
Task 1's RLS test. §1.6 merchant not searchable → nothing in this plan adds a
search. §2 data model → Task 1 verbatim. §3 semantics → Tasks 2-4. §4 merchant
in the UI → Task 5. §5 surfaces → Task 6. §6 out of scope → nothing here
implements autocomplete, category defaults, kind changes, or an audit trail.
§7 testing → distributed, with both load-bearing assertions (the transfer pair,
the occurrence identity) carrying explicit discrimination steps.

**Placeholders.** Tasks 5 and 6 specify assertions and the files to model on
rather than full JSX, because the components must match existing ones the
implementer has to read first. Every value they must hit — the label
precedence, the absent-not-disabled convention, the hidden-input pattern — is
named. Task 4 deliberately leaves the RPC-versus-two-statements choice to the
implementer but requires them to justify it, because the atomicity argument
matters more than the mechanism.

**Type consistency.** `TransactionEditInput` and `TransferEditInput` are
spelled identically in Tasks 2, 3, 4 and 6. `merchant` is the column, the
schema field and the `Row` field throughout. `recurring_occurrence_on` is the
column name everywhere and appears in no editable payload.
