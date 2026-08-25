# Wallet-Set Budgets — Design

**Status:** approved in conversation 2026-08-25, pending implementation plan.

**Supersedes:** `2026-08-22-budgets-design.md`, whose per-wallet model this
generalises. That spec's four headline decisions survive; only the *scope* of a
budget changes.

**Goal.** A budget applies to a chosen set of accounts — one, several, or all
of them — with all accounts as the default.

**Hard constraint, unchanged and set by the requester.** Budgets measure
**expenses only**. Income and transfers never count, in either direction.

---

## What changes, and why

The shipped model keys a budget to exactly one wallet. That answers *"how much
do we spend on groceries from the household account?"* but not *"how much do I
spend on groceries overall?"* — and the second is the question most people mean.

Rather than add a second, parallel "consolidated budget" concept, a budget gains
a **set of wallets**. The old model becomes the special case where that set has
one member.

| Wallet set | What it expresses |
|---|---|
| One wallet | Today's per-wallet budget. Still shared by that wallet's members. |
| Several wallets | A cap across a chosen subset. |
| All wallets | The default. Your total across everything you can see. |

This removes a concept rather than adding one: no second table, no second
aggregate, no second screen, and — see §3 — no sharing flag.

---

## Decisions

| Question | Decision | Why |
|---|---|---|
| Default scope | **All wallets** in the primary currency | The common case, and it matches the dashboard's own total. |
| Who sees a budget | Everyone who is a member of **every** wallet in its set | One rule; cannot leak (§3). |
| Category identity | Normalised **name**, not id | Category ids are wallet-scoped; a budget spanning wallets cannot use them (§2). |
| Overlapping budgets | **Allowed**; exact duplicates refused | Two budgets can legitimately watch the same spending at different scopes. |
| Multi-currency sets | **Forbidden**; all wallets in a set share a currency | A cap spanning SGD and USD has no meaning (§4). |
| Changing an amount | Each month keeps its own | Unchanged from the previous spec. |
| Rollover | None | Unchanged. |

---

## 1. Data model — migration `0013`

`0012` is already applied on `main` but **has never been pushed to the hosted
database**, so there is no production data to migrate. `0013` reshapes rather
than accretes.

```sql
create table budgets (
  id            uuid primary key default gen_random_uuid(),
  created_by    uuid not null references auth.users(id),
  currency_code char(3) not null,
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
```

- **`category_key IS NULL` is the overall cap** for that wallet set, exactly as
  `category_id IS NULL` was before.
- **`created_by` is provenance, not permission.** Visibility comes from the
  wallet set (§3). It exists so a budget can say who introduced it.
- **`currency_code` is denormalised deliberately.** It is derivable from the
  set's wallets, but storing it makes a budget self-describing and makes
  currency drift visible instead of silent (§4).
- Money stays `bigint` minor units. `parseFloat(x) * 100` remains banned.

### "All wallets" is materialised, not dynamic

Choosing "all accounts" writes **one `budget_wallets` row per matching wallet**
at creation time. It does not mean "whatever wallets exist whenever this is
read".

The alternative — a `covers_all_wallets` flag resolved at query time — would
auto-include wallets added later, but it cannot use §3's visibility rule: a
dynamic set has no fixed membership to test, so such a budget would have to be
personal to `created_by`, reintroducing the second visibility rule this design
exists to remove.

**Accepted cost: a wallet created after a budget is not covered by it.** The UI
must therefore never label a materialised set "All accounts" once it has gone
stale. It shows the count (`3 accounts`), and where the user has wallets in the
budget's currency that it does not cover, says so and offers to add them.

### Uniqueness moves out of the schema

`0012` enforced uniqueness with two partial indexes. A wallet *set* cannot be
expressed in a unique index without a canonical set key maintained by a trigger.

**Decision: enforce exact-duplicate rejection in the write function, not the
schema, and accept the weaker guarantee.** The reason the old constraint had to
be airtight was that a duplicate made the tracking query pick a row
*arbitrarily*. That is no longer true: overlapping budgets are now a supported
feature, so a duplicate renders as two identical rows — visibly wrong rather
than silently wrong. The cost is that a direct SQL insert could create one; the
alternative costs a trigger-maintained denormalised key that must stay correct
across every membership change.

---

## 2. Categories are keyed by name

Since `0008`, categories belong to a wallet. Two wallets each hold their own
"Groceries" row with different ids, so a budget spanning wallets cannot
reference a category id.

`category_key` is therefore `lower(btrim(name))`, paired with `kind` — the same
grouping `get_category_breakdown` has used since `0011`, so the budgets screen
and the dashboard breakdown merge categories identically.

**What this costs, stated plainly:**

1. **The composite foreign key is gone.** `0012` used
   `budgets_category_same_wallet` to guarantee a budget's category belonged to
   its wallet. With a name key there is no referent to constrain. A budget can
   name a category that no longer exists; it simply matches nothing.
2. **Renaming a category re-points its budget.** Renaming "Groceries" to
   "Food" orphans the Groceries budget and silently creates an unbudgeted
   "Food" line. This is the same behaviour the dashboard breakdown already has,
   but a budget makes it more visible.

Both are consequences of spanning wallets, not of this particular encoding.
Mitigation is out of scope here; §8 records it.

---

## 3. Visibility is a consequence, not a setting

```sql
create policy budgets_visible on budgets for all to authenticated
using (
  not exists (
    select 1 from budget_wallets bw
    where bw.budget_id = budgets.id
      and not is_wallet_member(bw.wallet_id)
  )
)
with check (
  not exists (
    select 1 from budget_wallets bw
    where bw.budget_id = budgets.id
      and not is_wallet_member(bw.wallet_id)
  )
);
```

A budget is visible to exactly those who can see **all** the money it covers.

- Set = `{Household}` → both members see it. Identical to `0012`'s behaviour, so
  the shared household cap survives unchanged.
- Set = `{Everyday, Household}` → only the person in both.
- Set = all your wallets → only you.

**Why this rule and not a shared/private flag.** A budget covering a wallet you
are not in would show you a figure derived from spending you cannot see, and
repeated reads would let you infer someone else's totals. The membership rule
makes that unrepresentable rather than merely disallowed, and it needs no
setting that could be misconfigured.

**Empty-set hazard.** `not exists` over zero rows is TRUE, so a budget with no
wallets would be visible to everyone. The write function must refuse to create
one, and `get_budget_status` must ignore any that exists. This is the
fails-open case in an otherwise fails-closed design and needs an explicit
adversarial test.

**`budget_wallets` needs its own policy**, gated on membership of the wallet
named in the row, so the join table cannot be read or written to enumerate
other people's wallet ids.

---

## 4. Currency

All wallets in a set must share a currency; a cap spanning SGD and USD is
meaningless. The write function rejects a mixed set.

**"All wallets" means all wallets in the primary currency** — the first-created
active wallet's currency, the same rule `src/app/(app)/page.tsx` already uses,
with the same visible disclosure when wallets are excluded. The budgets screen
and the dashboard must agree, since §6 puts a budget block on the dashboard.

**Primary currency can shift.** Archiving the first-created wallet changes it,
leaving budgets stored against the previous code. Those budgets stop matching.
Because `currency_code` is stored on the row, the screen can say so rather than
silently showing nothing.

---

## 5. The aggregate — `get_budget_status(from_date, to_date)`

Keeps its name and its `(from_date, to_date)` parameters; its **return columns
change**, so `src/lib/database.types.ts` must be regenerated and every caller
rechecked. Now returns one row per **budget**, plus one row per category with
spending that no budget covers.

```
budget_id, category_key, category_label, currency_code,
wallet_names text[], wallet_count int,
spent_minor bigint, budget_minor bigint, budget_period_start date
```

`category_key` is the normalised grouping key (§2); `category_label` is the
display form — the name as actually stored on one of the matched categories,
chosen deterministically (`min(name)`) so the same group always renders the same
label rather than varying by which wallet was read first.

- Self-scopes via the RLS predicate in §3 — no caller-supplied wallet filter.
- `where t.kind = 'expense' and t.deleted_at is null and t.occurred_on between
  from_date and to_date` — **unchanged from `0012`, and the single point where
  the requester's constraint is enforced.**
- Carry-forward is unchanged: the most recent row at or before the month for
  each `(wallet set, category_key)`, so a September budget governs October.
- `budget_minor` is NULL for unbudgeted spending — never 0.
- `wallet_names` powers the scope label (`All accounts`, `Everyday`,
  `Everyday + Savings`) without a second query.

Because budgets may overlap, **the same expense can count toward several rows.
That is intended** and must be stated in the UI, not just here.

---

## 6. UI

### `/budgets`

Lists **budgets**, not wallets — the grouping changes from `0012`'s
wallet-sectioned layout.

Each row: category (or `All spending`), its scope label, `spent of cap · n%`, a
bar, and — where over — `Over by <amount>` **in words**. Unbudgeted spending
follows below. Removing a budget keeps `0012`'s disclosure of which month's row
is being deleted.

Creating one: pick a category, an amount, and wallets — defaulting to all.
**The category picker lists the user's categories rather than only those with
spending**, which closes the dead-end shipped in `0012`, where a wallet with no
spending offered no control at all and removing a wallet's only budget made it
un-budgetable through the UI.

Accessible names carry over unchanged (`Budget amount`, `Save budget`,
`Remove budget for <category>`, `Remove overall budget`), plus
`Accounts this budget covers` for the wallet picker. Every name still appears
once per row, so selectors must be row-scoped.

### Dashboard

A block showing all-accounts budgets, reading the same function so the two
cannot disagree. Placed after the existing hero total, breakdown and cash-flow
blocks.

---

## 7. Testing

**SQL.** Expenses-only proven by a wallet holding all three kinds; a non-member
sees zero rows; a budget spanning a wallet the caller is not in is invisible;
**an empty wallet set is refused and, if forced, invisible**; a mixed-currency
set is refused; carry-forward picks the most recent row at or before the month;
overlapping budgets each report independently.

**Unit.** Progress derivation and carry-forward selection as pure functions
(`budget-status.ts` carries over). Action validation, the mixed-currency
rejection, the empty-set rejection, the exact-duplicate rejection that §1 moved
out of the schema and into the write function, and the zero-row delete guard.

**End-to-end.** Set an all-accounts budget, record an expense, see it counted;
record an income and a transfer and assert **neither** moves the figure — the
constraint this feature is defined by, asserted by rendered row count and not
only by a per-row figure, since a per-category assertion cannot fail (income
cannot reach an expense category through the picker, the server check, or
`transfer_shape`). Assert an expense in a wallet **outside** a budget's set does
not move it.

**Every denial gets a paired positive control**, and every guard must be watched
failing.

---

## 8. Out of scope

Rollover; sub-allocation (per-wallet caps as slices of a broader cap, with
validation and unallocated remainder); currency conversion; renaming a category
carrying its budget with it; weekly or annual periods; forecasting; notifications.

---

## 9. Risks

1. **`0013` is destructive to `0012`'s shape.** `0012` is on `main` but unpushed,
   so no hosted data is at risk. If it has been applied anywhere before `0013`
   lands, that database needs the table dropped and recreated, not altered.
2. **The empty-set fails-open case** (§3) is the one place this design is not
   fail-closed by construction. It is the highest-value adversarial test here.
3. **Name-keyed categories** lose the composite FK and re-point on rename (§2).
4. **Overlapping budgets double-count by design** (§5). A UI that does not say so
   will read as a bug.
