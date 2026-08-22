# Budgets — Design

**Status:** approved in conversation 2026-08-22, pending implementation plan.

**Goal.** Let someone set a monthly spending cap — per category and for a
wallet as a whole — and see how the month is tracking against it.

**Hard constraint, set by the requester.** Budgets measure **expenses only**.
Income and transfers never count toward a budget, in either direction.

---

## Decisions

| Question | Decision | Why |
|---|---|---|
| What is budgeted? | Per category **and** an overall cap | Categories say where an overrun happened; the cap lets a month be bounded without budgeting every category. |
| What does a budget belong to? | A **wallet**, shared by its members | Everyone in a wallet sees the identical figure — a genuine shared pot. Chosen over per-person budgets after the alternative's consequence was spelled out (see below). |
| Whose spending counts? | All spending in that wallet | Follows from the above: the budget tracks the wallet, not the person who recorded the transaction. |
| Changing an amount | Each month keeps its own | Raising a budget in October must not retroactively turn a September overrun into a month within budget. |
| Rollover | None | Each month starts at its full amount. Rollover makes every month's target depend on every prior month, so a corrected old transaction shifts everything after it. |

### The per-wallet decision, and what it cost

Two earlier answers pulled against each other: *categories merge across
wallets* (as `get_category_breakdown` already does since `0011`) and *all
spending in wallets I'm in counts*. Together they imply a budget belongs to a
**person** and covers whatever wallets that person can see — which means two
members of one shared wallet see **different** totals whenever either also
holds a wallet the other does not.

That was surfaced explicitly rather than built silently, and the per-wallet
model was chosen instead.

**Accepted cost.** A person with two personal wallets sets the same category
budget twice, once per wallet. There is no cross-wallet "Groceries" budget.

**Unlooked-for benefit.** A wallet has exactly one currency, so a budget is
simply in its wallet's currency. Budgets never encounter the multi-currency
problem `src/app/(app)/page.tsx` has to disclose around, where the dashboard
picks a primary currency and excludes wallets that do not match.

---

## 1. Data model — migration `0012`

```sql
create table budgets (
  id            uuid primary key default gen_random_uuid(),
  wallet_id     uuid not null references wallets(id) on delete cascade,
  category_id   uuid references categories(id) on delete cascade,
  period_start  date not null,
  amount_minor  bigint not null check (amount_minor > 0),
  created_at    timestamptz not null default now()
);
```

- **`category_id IS NULL` means the wallet's overall cap.** One nullable
  column rather than a second table: both answer the same question, differing
  only in scope.
- **`period_start` is the first day of a month.** Enforced by
  `check (extract(day from period_start) = 1)` so a mid-month date cannot
  create a period the tracking query will never match. Deliberately not
  `date_trunc('month', period_start)` — that takes a timestamp, so it would
  need a cast inside a CHECK, and a simple day-of-month test states the same
  rule without depending on cast immutability.
- **`amount_minor > 0`.** A zero budget is indistinguishable from no budget;
  deleting the row is how you remove one.
- Money is `bigint` minor units, as everywhere else in this schema.

### Uniqueness needs TWO partial indexes, not one constraint

```sql
create unique index budgets_category_period
  on budgets (wallet_id, category_id, period_start) where category_id is not null;

create unique index budgets_overall_period
  on budgets (wallet_id, period_start) where category_id is null;
```

A single `unique (wallet_id, category_id, period_start)` would **not** work.
Postgres treats NULLs as distinct in unique indexes, so it would silently
permit any number of overall caps for the same wallet and month — the
tracking query would then pick one arbitrarily.

### A budget cannot reference another wallet's category

```sql
alter table budgets
  add constraint budgets_category_same_wallet
  foreign key (category_id, wallet_id) references categories (id, wallet_id);
```

Reuses the pattern `0008` established for `transactions`, resting on the same
`categories (id, wallet_id)` unique constraint. `MATCH SIMPLE` skips the check
when `category_id` is null, which is exactly right for the overall cap.

### RLS

```sql
create policy budgets_member on budgets
  for all to authenticated
  using (is_wallet_member(wallet_id)) with check (is_wallet_member(wallet_id));
```

Member-writable, not owner-only — the same predicate `transactions_member` and
`categories_member` already use. Members are equal on money; owner-only is
reserved for membership and archiving.

Explicit grants are mandatory (`0004`'s own comment: the default ACL gives
`authenticated` no DML, so a policy without a grant is dead code).

---

## 2. Carry-forward semantics

Setting a budget writes a row for the **current** month. Tracking any month
`M` uses **the most recent row at or before `M`** for that
`(wallet_id, category_id)` pair:

```sql
select distinct on (wallet_id, category_id) ...
  from budgets where period_start <= M
 order by wallet_id, category_id, period_start desc
```

So one row set in September governs October, November and onward until
another is written — and raising the amount in October leaves September
measured against September's row. History stays true without requiring a row
per month per category.

Deleting a budget removes that row only; an earlier row, if present, resumes
governing later months. That is a deliberate consequence, documented here so
it is not discovered as a surprise.

---

## 3. The aggregate — `get_budget_status(from_date, to_date)`

```sql
create function get_budget_status(from_date date, to_date date)
  returns table(
    wallet_id uuid, wallet_name text, currency_code char(3),
    category_id uuid, category_name text, color_slot smallint, icon text,
    spent_minor bigint, budget_minor bigint
  )
  language plpgsql stable security definer set search_path = '' as $$
```

**No wallet-ids parameter.** It self-scopes via `is_wallet_member`, the same
shape `get_wallet_members` and `get_pending_invites` use — there is no
caller-supplied filter to tamper with, and nothing to enumerate.

**Expenses only is enforced here, in SQL:**

```sql
where t.kind = 'expense'
  and t.deleted_at is null
  and t.occurred_on between from_date and to_date
```

`t.kind = 'expense'` is the same filter `get_category_breakdown` already
applies. Transfers are excluded twice over — by `kind`, and because the
`transfer_shape` CHECK in `0003` forces their `category_id` to NULL. Income
cannot leak in even if someone sets a budget against an income category.

**Rows returned:** one per budget (so a budget with no spending still shows
`spent_minor = 0`), plus one per category that has spending but no budget
(so unbudgeted spending is visible rather than silently absent). For those,
`budget_minor` is **NULL**, not 0 — "no budget set" and "budgeted at zero"
must stay distinguishable, and `amount_minor > 0` means a real budget can
never be 0 anyway. The UI renders a NULL budget as spending with no target
rather than as an instant overrun.

The overall cap's row has `category_id IS NULL` and sums every expense in the
wallet, including categories that have no budget of their own. It is
therefore **not** the sum of the category rows, by design — that is what
makes an overall cap useful when only some categories are budgeted.

**Grants:** `revoke all ... from public, anon` then `grant execute ... to
authenticated`, following `0009`/`0010` rather than `0006`. This function
returns wallet names and category names — identity-adjacent enough to warrant
the explicit boundary rather than relying on NULL-predicate self-filtering.

---

## 4. Server actions

In `src/server/actions/budgets.ts`, following the conventions documented at
the top of `src/server/actions/wallets.ts`: reachable by direct POST, so each
re-derives the caller via `getUser()` and re-validates with zod; each RETURNS
errors and never throws.

- `setBudget({ wallet_id, category_id | null, amount })` — upserts the row for
  the current month. Membership re-checked ahead of RLS so a non-member gets a
  readable message rather than a policy violation.
- `removeBudget(id)` — deletes, and asserts affected rows, because RLS turns
  "not yours" into zero rows rather than an error. That silent-false-success
  is the failure `archiveWallet` and `revokeInvite` were both fixed for.

Amounts arrive as text and go through `parseAmountInput` with the wallet's
`minorUnitFor(currency_code)`. `parseFloat(x) * 100` is banned project-wide.

---

## 5. UI

A `/budgets` route, grouped by wallet:

- The wallet's **overall cap**, then each budgeted category, then any
  unbudgeted category that has spending this month.
- Progress shown as a bar **and** as figures (`$412 / $600 · 69%`).
- Over-budget stated in **words** ("over by $45"), never colour alone —
  §6.4's rule, and the same reason transaction amounts always render their
  sign as text.
- Editing is inline per row, mirroring `CategorySection`'s existing shape.

Added to the nav alongside Categories.

**Deliberately not on the dashboard yet.** A budget summary there is
reasonable follow-up work, but the dashboard already carries a hero total,
a category breakdown and a cash-flow chart; adding a fourth block is a layout
decision worth taking on its own evidence.

---

## 6. Testing

**SQL.** `get_budget_status` excludes income and transfers (assert a wallet
holding all three kinds reports only the expense); a non-member gets zero
rows; the two partial unique indexes each reject their duplicate; the
composite FK rejects a cross-wallet category; carry-forward picks the most
recent row at or before the month.

**Unit.** The carry-forward selection and the over/under/percentage
derivation as pure functions, extracted the way `wallet-rows.ts` and
`attribution.ts` already are. Action validation and the zero-row delete guard.

**End-to-end.** Set a budget, record an expense, see it counted; record an
income and a transfer in the same wallet and assert **neither** moves the
number — the constraint this feature is defined by deserves a browser-level
assertion, not only a SQL one.

---

## 7. Risks

1. **`0012` is additive** — a new table, a new function, no backfill and no
   change to existing rows. Materially safer than `0008`, which rewrote
   `transactions.category_id` in place. The `DEPLOY.md` backup guidance still
   applies, but there is nothing here to rehearse against restored data.
2. **Deleting a budget can resurrect an older one** (§2). Documented, not
   prevented; preventing it would mean tombstone rows for a case that is
   plausibly what someone wants anyway.
3. **Archiving a category leaves its budget row.** The budget simply stops
   matching spending. Acceptable; `on delete cascade` covers actual deletion,
   which the app never does.

## 8. Out of scope

Rollover; per-member budgets within a shared wallet; budgets on income or
transfers; cross-wallet merged budgets; weekly or annual periods; forecasting
or "safe to spend"; notifications when a budget is exceeded.
