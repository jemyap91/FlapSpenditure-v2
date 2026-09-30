# Refunds (repayments) — design

**Status:** DRAFT 2026-09-30, awaiting review. New transaction kind; changes the
spend reports.

**Goal:** when someone pays you back for an expense you covered — matcha for
five, four friends transfer their share — the repayment offsets that expense's
category, in the expense's month, while wallet balances still show the money
where it actually moved.

```
Matcha        expense   Card   Eating out   30 Sep   -25.00
Alice paid    refund    Bank   (→ Matcha)    2 Oct    +5.00   ×4
→ Eating out, September, Card: net spend 5.00
→ Card balance -25.00, Bank balance +20.00
```

## 1. Decisions

| Decision | Choice |
|---|---|
| How a repayment is recorded | A new `txn_kind` value, `refund`: positive amount, linked to one expense. |
| Link | **Required.** Every refund names exactly one expense (`refund_of`). No cap on the total repaid. |
| Attribution in spend reports | The **expense's** wallet, category and date. |
| Attribution in money reports | The refund's **own** wallet and date (balances, cash flow). |
| Currency | A refund's currency must equal its expense's. |
| Where it is recorded | From the expense ("Record repayment"); no Refund option in the general form. |
| Storage | The refund stores only the link; reports resolve it (no copied category/date/wallet). |
| Lump-sum repayments (claims, trip settlements) | Out of scope. Recorded as income. Splitting one repayment across several expenses is a possible later extension. |

### Rejected alternatives

- **Copy attribution onto the refund row** (`category_id`, `attributed_on`,
  `attributed_wallet_id`, kept in sync by triggers): three duplicated facts that
  can drift — the same class of problem 0022/0023 removed for categories.
- **Positive-amount `expense` rows:** drops `expense_is_negative`, the check
  that currently catches a mistyped sign, and makes "expense" mean two things
  to the ledger, recurring rules and MCP.
- **Optional link / unlinked refunds under an expense category:** more
  flexible, but an unlinked refund counts in the month received, reopening the
  cross-month problem this feature exists to fix.

## 2. Data model

### 2.1 Migrations

`ALTER TYPE ... ADD VALUE` cannot be used by the transaction that adds it, so
the change is two files:

- **`0029_refund_kind.sql`** — `alter type txn_kind add value 'refund';` only.
- **`0030_refunds.sql`** — everything below.

### 2.2 Column and constraints

```sql
alter table transactions add column refund_of uuid;
alter table transactions add constraint transactions_id_space_unique unique (id, space_id);
alter table transactions add constraint transactions_refund_same_space
  foreign key (refund_of, space_id) references transactions (id, space_id)
  deferrable initially immediate;
create index transactions_refund_of on transactions (refund_of) where refund_of is not null;

alter table transactions add constraint refund_shape check (
  kind <> 'refund' or (refund_of is not null and category_id is null and amount_minor > 0
                       and transfer_id is null and recurring_id is null));
alter table transactions add constraint non_refund_no_link check (
  kind = 'refund' or refund_of is null);
```

`NO ACTION`, not `RESTRICT`: the key is deferrable (like 0025's other
`*_same_space` keys) so `leave_space` can move an expense and its refund in
separate statements, and a deferrable key cannot be `RESTRICT`. `NO ACTION` is
checked at statement end, so an account deletion cascading through both rows
succeeds, while a delete that would leave a refund behind is still refused.

The composite FK means a refund can only point at an expense in its own
household — the same `*_same_space` pattern 0022 uses for wallets and
categories.

### 2.3 Triggers

A foreign key cannot check columns of the referenced row, so two small
triggers carry the remaining rules. Both are `security definer` with
`search_path = ''` and schema-qualified references, per this repo's
convention (0006).

**`check_refund_parent`** — `before insert or update of refund_of,
currency_code, deleted_at` on rows where `kind = 'refund'` and
`deleted_at is null`. The referenced row must:

1. exist with `kind = 'expense'`,
2. have `deleted_at is null` (this also blocks restoring a refund whose
   expense has since been deleted),
3. have the same `currency_code`,
4. be in a wallet the caller is a member of (`is_wallet_member`) — skipped
   when `auth.uid()` is null (service/superuser scripts).

**`guard_refunded_expense`** — `before update of deleted_at, currency_code,
kind` on rows whose old `kind = 'expense'`. While the expense has live refunds
it rejects:

1. soft-deleting it (`'this expense has repayments; delete them first'`),
2. changing its `kind` — 0004 grants `kind` to `authenticated`, so without
   this a direct PATCH could turn a repaid expense into income,
3. changing its `currency_code` (also granted by 0004; a wallet move cannot
   change currency, `transactions_currency_matches_wallet` already forbids
   that).

Recategorising an expense, or changing its amount or date, is unrestricted;
its refunds follow because they store nothing but the link.

### 2.4 Unchanged

Grants: `refund_of` is deliberately **not** granted for update, so a refund
cannot be re-pointed at another expense — delete it and record a new one. A
refund's own `kind` cannot change either: `non_refund_no_link` rejects any
non-refund kind while `refund_of` is set. Also unchanged:
`get_wallet_balances`, transfers, recurring rules.

### 2.5 Visibility trade-off (accepted)

A refund recorded into a private wallet against an expense in a
household-shared wallet lowers that expense's category total for everyone who
can see the shared wallet, though they cannot see the refund row. Accepted:
the refund is attributed to the shared expense by definition.

## 3. Reporting

### 3.1 `public.spend_lines` view

`security_invoker = true`. One row per live expense and per live refund whose
expense is live:

| column | expense row | refund row |
|---|---|---|
| `transaction_id` | itself | itself |
| `wallet_id` | own | expense's |
| `category_id` | own | expense's |
| `occurred_on` | own | expense's |
| `spend_minor` | `-amount_minor` (positive) | `-amount_minor` (negative) |
| `currency_code` | own | own (= expense's) |

Defined as `union all` of expenses and refunds joined to their parent, both
sides filtered on `deleted_at is null`.

### 3.2 Changed

- **`get_category_breakdown`** reads `spend_lines` instead of
  `transactions where kind = 'expense'`. Keeps 0011's grouping by
  `(kind, lower(btrim(name)))` and the up-front every-element membership
  check. Adds `having sum(spend_minor) > 0`: a category fully or over-repaid
  drops out of the chart rather than drawing a negative slice.
- **`get_budget_status`** — the `spend` and `uncovered` CTEs read
  `spend_lines`. Because the view carries the expense's wallet, a budget
  scoped to the card wallet sees a repayment that landed in the bank.
- **Ledger (`/transactions`)** — a refund row shows its expense's category
  icon, the label "Repayment · ‹expense note›", and a positive amount in the
  income colour. The category filter also matches refunds whose expense is in
  that category.

### 3.3 Unchanged, deliberately

`get_wallet_balances` and `get_cash_flow` read real rows: a repayment is
money that arrived in the bank wallet on the day it arrived. Balances and cash
flow are the money lens; breakdown and budgets are the spend lens. Transfers
already sit only in the first; refunds sit in both with different attribution,
and `spend_lines` is the one place that difference is defined.

## 4. Application

### 4.1 Validation

`refundInput` in `src/lib/validation/transaction.ts`: `refund_of` (uuid),
`wallet_id`, `amount` (> 0, parsed the same way as other amounts),
`occurred_on`, optional `note` (≤ 280) and `merchant` (≤ 120). No category.

### 4.2 Server actions (`src/server/actions/transactions.ts`)

- **`createRefund(expenseId, input)`** — new; the only way to create a refund.
- **`updateTransaction`** — accepts refunds; rejects a category on one. A
  wallet move goes through `move_transaction` with `p_category_id = null`.
- **Delete / restore** — existing actions. Trigger errors map to:
  "This expense has repayments. Delete them first." and "The expense this
  repaid was deleted."

### 4.3 UI

- **Expense edit page** — a *Repayments* panel below the form:
  - summary: `Paid 25.00 · Repaid 20.00 · Your share 5.00`;
  - list of repayments (date, wallet, amount, note), each linking to its edit
    page;
  - **Record repayment** inline form: wallet (defaults to the expense's),
    amount, date (today), note. After a save it clears the amount and stays
    open, for recording several people in a row.
- **Refund edit page** — the same small form, headed "Repayment for
  **‹expense note›** · ‹date›" linking back to the expense.
- `TransactionForm`'s kind toggle is unchanged.

### 4.4 MCP (`src/server/mcp/tools.ts`)

- `list_transactions` — `kind` filter accepts `"refund"`; rows include
  `refund_of` and the category resolved through the expense.
- **`record_repayment { expense_id, amount, wallet_id?, occurred_on?, note? }`**
  — new; `wallet_id` defaults to the expense's wallet, `occurred_on` to today.
- `update_transaction`, `delete_transaction`, `restore_transaction` work on
  refunds under the same rules as the app.

## 5. Backfilling previously imported repayments

The 2026-09-30 import of a legacy CSV held back 17 rows that were INCOME filed
under expense categories. They are loaded by a one-off script against
production after 0029/0030 deploy — not a migration, since user data does not
belong in the repo. The row-by-row mapping lives with that script, outside the
repo.

- **Repayments of a single identifiable expense** (about 6–8 rows) become
  refunds. The linked expense for each is confirmed by the account owner
  before the script is run; the script finds it in production by
  (wallet, date, amount, note) and aborts if any lookup matches zero or several
  rows.
- **Lump-sum claims and trip settlements** become income under new income
  categories *Claims* and *Other income* respectively.
- **Gifts and government payouts** become income under *Gifts received* and
  *Government*.

Same safety shape as the import: one transaction, an exact-count check, and a
guard that refuses a second run.

## 6. Testing

- **SQL constraint tests** (`scripts/test-constraints.sh`): every shape check;
  refund → income, → transfer, → other household's expense, → deleted
  expense; currency mismatch; deleting an expense with live refunds; changing
  its kind or currency; restoring a refund whose expense is deleted.
- **RLS tests** (`scripts/test-rls.sh`): a caller cannot link to an expense in
  a wallet they are not a member of.
- **Report tests (SQL):** `spend_lines`, `get_category_breakdown` and
  `get_budget_status` with a refund in a different wallet and month from its
  expense; a fully repaid category drops out of the breakdown.
- **Vitest:** `refundInput`; `createRefund`; trigger-error mapping; MCP
  `record_repayment` and `list_transactions` with `kind: "refund"`.
- **Playwright** (`e2e/refunds.spec.ts`): card expense 25.00 in Eating out →
  four 5.00 repayments into the bank wallet from the expense page → breakdown
  shows Eating out 5.00 and the bank balance is up 20.00.

## 7. Out of scope

- Splitting one repayment across several expenses (allocation table).
- Tracking who still owes you ("2 of 4 paid back").
- A Refund option in the general transaction form.
- Recurring refunds.
