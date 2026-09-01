# Recurring entries — design

**Status:** APPROVED 2026-09-01. Supersedes nothing; this is a new subsystem.

**Goal:** let a user describe a repeating expense or income once — rent,
Spotify, salary — and have each occurrence offered for recording on the date
it falls due, without the app ever asserting that money moved when it did not.

---

## 1. The decisions, and why

These were settled with the user before design. They are the constraints every
later section obeys.

### 1.1 A due occurrence is offered, never auto-recorded

The app shows an occurrence as **due** and the user records it with one tap.
Nothing is written to the ledger until they do.

Rejected: **automatic recording on a schedule.** It needs infrastructure this
project does not have — no `pg_cron`, no Supabase edge functions, no Vercel
cron jobs exist today — and a job that writes to the ledger needs
`SUPABASE_SERVICE_ROLE_KEY` reachable from wherever it runs. That credential is
deliberately absent from the frontend project. It is also wrong on the merits:
a direct debit that failed would be recorded as though it succeeded, and the
user would have to notice a silent error rather than an obvious omission.

Rejected: **catch-up on next app open.** No new infrastructure, but a read that
writes is surprising, races across two tabs, and leaves balances stale for as
long as the app is closed — which is exactly when a user wants them right.

Consequence, and the reason this fits: **balance keeps meaning "money that
actually moved."** Budgets, balances and the dashboard all count transactions;
a due occurrence is not one. No feature needs special-casing.

### 1.2 Expenses and income recur; transfers do not

Salary is the other genuinely recurring thing in most people's finances, and
the machinery is identical to an expense — a kind, a category, a wallet, an
amount.

Transfers are excluded deliberately. A transfer is a PAIR of rows sharing a
`transfer_id` with no category (`0003_transactions.sql`'s `transfer_shape`
CHECK), so recording one is a different operation with a different failure
mode. Excluding it keeps this subsystem's write path a single INSERT.

### 1.3 Every missed occurrence is listed separately

Three missed months produce three due items, each recordable or skippable on
its own, each landing on **its own date**.

Rejected: **only the latest.** A missed month would leave a silent hole — the
July report would read £0 spent on rent with nothing saying why.

Rejected: **one bulk catch-up item.** Fewer taps, but it collapses three
independent decisions ("did I actually pay July's?") into one.

### 1.4 A rule may have an optional end date

`ends_on` is nullable. Null means it runs indefinitely. A fixed-term
subscription or a loan with a final payment gets an end.

### 1.5 Due occurrences reach back 12 months, capped at 24

A rule anchored in 2020 would otherwise generate sixty due items on first
render. Generation starts at the later of the rule's anchor and twelve months
before today, and yields at most 24 occurrences per rule — **the 24 most
recent**, not the first 24 found.

That distinction is not pedantic. Twelve months of a WEEKLY rule is about 52
occurrences, so the cap binds routinely rather than only in the 2020 edge
case, and keeping the oldest 24 would hide last week's while offering one from
ten months ago. The user cares most about the most recent.

When the backstop drops older occurrences, the UI **says so**. A silent
truncation reads as "you are up to date", which is the one thing it must not
imply.

---

## 2. Data model

### 2.1 `recurring_rules`

```sql
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

  -- Mirrors 0003's own sign constraints, so a rule cannot describe a
  -- transaction the ledger would refuse to hold.
  constraint rule_expense_is_negative check (kind <> 'expense' or amount_minor < 0),
  constraint rule_income_is_positive  check (kind <> 'income'  or amount_minor > 0),
  -- Transfers are out of scope (§1.2). Enforced in the table, not only in a
  -- form: a Server Function is reachable by direct POST.
  constraint rule_kind_not_transfer   check (kind <> 'transfer'),
  constraint rule_ends_after_anchor   check (ends_on is null or ends_on >= anchor_on)
);
```

`category_id` is NOT NULL, unlike `transactions.category_id`. A transaction may
legitimately lack a category (a transfer's rows must); a recurring rule always
describes categorised spending or income, and requiring it here means the
recording path never has to invent one.

The column is `interval_unit`, not `interval`: `INTERVAL` is an SQL type name
and a keyword, and a column called that needs quoting in enough contexts —
and reads ambiguously in enough others — to be worth avoiding outright.

`anchor_on` carries both the start date and the schedule's phase — the day of
month for monthly, the weekday for weekly, the month-and-day for yearly. One
column rather than an interval-dependent set of nullable ones.

### 2.2 `recurring_skips`

```sql
create table recurring_skips (
  rule_id       uuid not null references recurring_rules(id) on delete cascade,
  occurrence_on date not null,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  primary key (rule_id, occurrence_on)
);
```

The composite primary key is the idempotency guarantee: skipping twice is a
no-op rather than two rows.

### 2.3 `transactions.recurring_id`

```sql
alter table transactions
  add column recurring_id uuid references recurring_rules(id) on delete set null;

create unique index transactions_recurring_occurrence
  on transactions (recurring_id, occurred_on)
  where recurring_id is not null and deleted_at is null;
```

`on delete set null`, NOT cascade. Deleting a rule must never delete money that
was actually spent — the transactions stay, they simply stop pointing at a rule.
This is the opposite of `wallet_id`'s cascade, and deliberately so.

The partial unique index is what makes **Record idempotent**: a double-tap, a
retried request, or two tabs cannot produce two rent rows for 1 July. Scoped
`where deleted_at is null` so that deleting a recorded occurrence genuinely
frees it to be recorded again.

### 2.4 RLS

Both tables scope through the wallet, using the project's single membership
predicate `is_wallet_member(wallet_id)` — the same one `transactions` uses.

A recurring rule targets a wallet, and `/wallets` lists SHARED wallets, so a
household's rent rule is visible to both members. That follows from the
existing model rather than introducing a second notion of ownership.

Write policies match `transactions`': any member of the wallet may create,
record and skip. Archiving a rule likewise. This is intentionally NOT
owner-only — unlike archiving a *wallet*, which is owner-scoped — because a
recurring rule is ledger content, and members already write ledger content.

---

## 3. Computing due occurrences

Pure date arithmetic over `date` values. No timestamps, no timezones: this
project has already shipped one month-range timezone bug, and every input here
is a calendar date.

```
occurrencesFor(rule, today):
  floor = max(rule.anchor_on, today - 12 months)
  dates = []
  for n = 0, 1, 2, ...:
    d = nth(rule.anchor_on, rule.interval_unit, n)  # ALWAYS from the anchor
    if d > today: break
    if rule.ends_on is not null and d > rule.ends_on: break
    if d < floor: continue                      # older than the backstop
    dates.push(d)
  return last 24 of dates                       # most recent, not first
```

Note the shape: every occurrence is the **nth step from `anchor_on`**, never
one step from the previous occurrence. §3.1 explains why, and an
implementation that iterates `d = advance(d, ...)` would satisfy this
pseudocode's output for every interval EXCEPT monthly, where it silently
introduces the drift §3.1 forbids. The loop is written this way so the two
cannot diverge.

`advance` by `interval_unit`:

- **weekly** — +7 days
- **fortnightly** — +14 days
- **yearly** — +1 year, clamped (29 Feb in a non-leap year becomes 28 Feb)
- **monthly** — +1 month, **clamped to the month's last day**

### 3.1 Month-end clamping, stated exactly

A rule anchored on the 31st occurs on 31 Jan, 28 Feb (29 in a leap year),
31 Mar. It clamps to the month's last day; it does not skip short months, and
it does not drift.

Drift is the failure this rule exists to prevent. Naively advancing from a
clamped date — 31 Jan → 28 Feb → 28 Mar — permanently moves a rule off its
anchor after one short month. **Each occurrence is therefore computed from
`anchor_on`, not from the previous occurrence.**

### 3.2 Handled vs due

An occurrence date is **handled** if either:

- a non-deleted transaction exists with that `(recurring_id, occurred_on)`, or
- a `recurring_skips` row exists with that `(rule_id, occurrence_on)`.

Everything else is **due**. Two set lookups, no stored occurrence rows, no
state to drift, and Record/Skip work in any order — recording August while
July is still outstanding leaves July due, which is what §1.3 asked for.

### 3.3 Occurrences are never generated in the future

`d <= today`. A rule due on the 30th shows nothing on the 15th. The DUE list
is a list of things owed now, not a forecast — forecasting is out of scope
(§6).

---

## 4. Recording and skipping

**Record** inserts a transaction with the rule's kind, amount, currency,
category and wallet, `occurred_on` set to **the occurrence's date, not today**,
and `recurring_id` set. It re-validates exactly what manual entry validates:

- the wallet is active — `transactions.ts` already refuses an archived wallet;
- the category's kind matches the transaction's kind, the same check manual
  entry makes;
- the wallet's currency matches the rule's.

A rule whose wallet has since been archived, or whose category was archived,
therefore cannot be recorded. Its due items render with the reason stated
rather than a button that fails on press.

**Skip** inserts a `recurring_skips` row. Both are ordinary Server Functions
returning `{ error }` rather than throwing, matching every other action in this
codebase — Next replaces thrown server errors with an opaque digest in
production, and these messages are guidance the user must be able to read.

**Undo.** Recording is undoable by deleting the resulting transaction, which is
the existing transaction-delete path; the partial unique index then frees the
occurrence to be recorded again. Skipping is undoable by deleting the skip row.

---

## 5. Surfaces

- **The dashboard (`/`)** carries the DUE section, above the hero total: rule
  name, occurrence date, amount, and Record / Skip per row. It is the signed-in
  landing screen, so a bill that needs recording is seen without navigating to
  it — which is the whole point of surfacing it at all.

  **Absent entirely when nothing is due.** Not an empty state, not a "You're
  all caught up" card: the dashboard is opened many times a day and most of
  those times there will be nothing owed, so the section must cost zero space
  in the common case.

  Due items are actionable content on a screen that is otherwise a set of
  read-only summaries. That is the point — the dashboard already answers "how
  am I doing"; this adds "and here is what needs recording".

- **`/recurring`** manages rules: list, create, edit, pause (archive). Reached
  by a link from the DUE section on the dashboard, and — because that section
  is absent when nothing is due — also from `/transactions`, so the management
  screen is never unreachable. **Not a nav tab:** the mobile tab bar was just
  reduced from six items to five to stop wallet names truncating, and adding
  Recurring would undo that.

- **`/transactions`** — unchanged apart from that link. Recorded occurrences
  appear there as ordinary transactions, which is exactly what they are.

- **Dashboard figures are unchanged.** The hero total, category breakdown and
  cash flow all count transactions, and a due occurrence is not one until
  recorded. The DUE section sits above them without altering any of them —
  recording an item is what moves the numbers, which is the correct causality
  and needs no special-casing anywhere.

---

## 6. Deliberately out of scope

- **Transfers** (§1.2).
- **Forecasting** — "what will my balance be on payday". The DUE list shows
  what is owed now; projecting forward is a different feature.
- **Variable amounts** — a rule has one amount. A bill that changes each month
  is recorded manually, or the rule is edited.
- **Notifications / reminders** — needs the scheduling infrastructure §1.1
  rejected.
- **Auto-detecting recurrence** from existing transactions.
- **Un-archiving a rule.** Consistent with wallets and categories, which have
  the same gap; it is not made worse here.

---

## 7. Testing

- **Date arithmetic, unit** — month-end clamping (31st across Jan/Feb/Mar), the
  29 Feb leap case, drift (a rule anchored on the 31st must still be on the
  31st in March, not the 28th), weekly/fortnightly/yearly advance, `ends_on`
  respected, the 12-month floor, and the 24 cap **keeping the most recent** —
  a weekly rule running a full year must offer last week's occurrence, not
  one from ten months ago. Both cap tests are needed: that it truncates, and
  which end it truncates. This is pure and deserves the
  densest coverage in the feature.
- **Due/handled computation, unit** — recorded excluded, skipped excluded,
  out-of-order Record/Skip, a deleted transaction returning its occurrence to
  due.
- **RLS, SQL** — a non-member sees no rules and can neither record nor skip;
  a co-member of a shared wallet can do both.
- **Constraints, SQL** — the sign checks, `kind <> 'transfer'`, `ends_on >=
  anchor_on`, and the partial unique index refusing a second transaction for
  one occurrence.
- **E2E** — create a rule, see it due ON THE DASHBOARD, record it, and assert
  the resulting transaction is dated **the occurrence's date, not today**.
  Assert too that the dashboard's own figures move only AFTER recording, and
  that the section is absent when nothing is due — the common case, and the
  one where a stray empty card would be most annoying. That assertion is
  load-bearing: a test that only checked a transaction appeared would pass with
  the whole of §1.3 broken.

---

## 8. Open questions

None. The five decisions in §1 were settled with the user; everything else in
this document follows from them or from existing codebase convention.
