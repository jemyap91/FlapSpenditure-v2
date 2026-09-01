# Recurring Entries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** let a user describe a repeating expense or income once and have each
occurrence offered for recording on the date it falls due, without the app ever
asserting money moved when it did not.

**Architecture:** two new tables (`recurring_rules`, `recurring_skips`) and one
new column (`transactions.recurring_id`). Occurrence dates are **computed** from
a rule's anchor, never stored; an occurrence is handled if a transaction or a
skip row exists for it. The dashboard shows what is due; recording writes an
ordinary transaction dated to the occurrence, not to today.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres with RLS, TypeScript
strict, Tailwind, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-01-recurring-entries-design.md`

## Global Constraints

- **Never construct a `Date` from local components for calendar arithmetic.**
  `src/lib/month-range.ts`'s doc comment records a shipped Critical bug where
  `new Date(y, m, 1)` (local midnight) read back through `.toISOString()` (UTC)
  shifted a whole month window by a day in UTC+8. Every date in this feature is
  a plain `date` column with no timezone. Use UTC-only `Date.UTC(...)` +
  `getUTC*` for day arithmetic, or pure integer maths — never local
  constructors, never `toISOString()` on a locally-built Date.
- **Migration number is `0015`.** `0014_rls_initplan.sql` exists unmerged on
  branch `worktree-perf`; the gap is deliberate, so both can land.
- **Money is bigint minor units end-to-end.** Never `parseFloat(x) * 100`.
  `parseAmountInput` / `formatAmountInput` in `src/lib/money.ts` are the only
  conversions.
- **Sign follows kind:** expense amounts are negative, income positive, matching
  `0003_transactions.sql`'s `expense_is_negative` / `income_is_positive`.
- **Transfers are out of scope.** A rule's kind may only be `expense` or
  `income`.
- **Server Functions return `{ error }`, never throw** user-facing text. Next
  replaces thrown server errors with an opaque digest in production.
- **RLS scopes through `is_wallet_member(wallet_id)`** — the project's single
  membership predicate (`supabase/migrations/0004_rls.sql:13`).
- **Say "wallet", never "account"**, when a wallet is meant.
- **SQL test suites are loopback-only.** `npm run test:rls` and
  `npm run test:constraints` must never target a hosted database.

---

### Task 1: The recurrence library

Pure date arithmetic and the due/handled computation. No database, no React.
This is the densest-tested unit in the feature because every later task trusts
it.

**Files:**
- Create: `src/lib/recurrence.ts`
- Test: `src/lib/recurrence.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type RecurInterval = "weekly" | "fortnightly" | "monthly" | "yearly";
  export type RecurrenceRule = {
    anchorOn: string;            // "YYYY-MM-DD"
    intervalUnit: RecurInterval;
    endsOn: string | null;       // "YYYY-MM-DD"
  };
  export type Occurrences = { dates: string[]; olderDropped: boolean };
  export function occurrencesFor(rule: RecurrenceRule, today: string): Occurrences;
  export function dueOccurrences(
    rule: RecurrenceRule,
    today: string,
    handled: ReadonlySet<string>,
  ): Occurrences;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { occurrencesFor, dueOccurrences, type RecurrenceRule } from "./recurrence";

const monthly = (anchorOn: string, endsOn: string | null = null): RecurrenceRule => ({
  anchorOn,
  intervalUnit: "monthly",
  endsOn,
});

describe("occurrencesFor", () => {
  it("yields the anchor itself when it is today", () => {
    expect(occurrencesFor(monthly("2026-09-01"), "2026-09-01").dates).toEqual(["2026-09-01"]);
  });

  it("yields nothing before the anchor", () => {
    expect(occurrencesFor(monthly("2026-09-10"), "2026-09-01").dates).toEqual([]);
  });

  it("never yields a future occurrence", () => {
    // A rule due on the 30th shows nothing on the 15th (spec §3.3).
    const { dates } = occurrencesFor(monthly("2026-01-30"), "2026-03-15");
    expect(dates).toEqual(["2026-01-30", "2026-02-28"]);
  });

  it("clamps a month-end anchor to each month's last day", () => {
    const { dates } = occurrencesFor(monthly("2026-01-31"), "2026-04-30");
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  /**
   * THE anti-drift case (spec §3.1). Computing each occurrence by advancing
   * from the PREVIOUS one gives 31 Jan, 28 Feb, 28 Mar — the rule silently
   * moves off the 31st forever after one short month. Every occurrence must
   * be the nth step from the ANCHOR.
   */
  it("returns to the 31st in March rather than drifting to the 28th", () => {
    const { dates } = occurrencesFor(monthly("2026-01-31"), "2026-03-31");
    expect(dates[2]).toBe("2026-03-31");
  });

  it("clamps 29 February to the 28th in a non-leap year", () => {
    const { dates } = occurrencesFor(
      { anchorOn: "2024-02-29", intervalUnit: "yearly", endsOn: null },
      "2025-12-31",
    );
    expect(dates).toEqual(["2024-02-29", "2025-02-28"]);
  });

  it("advances weekly and fortnightly by whole days", () => {
    expect(
      occurrencesFor({ anchorOn: "2026-08-31", intervalUnit: "weekly", endsOn: null }, "2026-09-14")
        .dates,
    ).toEqual(["2026-08-31", "2026-09-07", "2026-09-14"]);
    expect(
      occurrencesFor(
        { anchorOn: "2026-08-31", intervalUnit: "fortnightly", endsOn: null },
        "2026-09-28",
      ).dates,
    ).toEqual(["2026-08-31", "2026-09-14", "2026-09-28"]);
  });

  it("stops at ends_on, inclusive", () => {
    const { dates } = occurrencesFor(monthly("2026-01-15", "2026-03-15"), "2026-06-01");
    expect(dates).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
  });

  it("reaches back no further than twelve months", () => {
    const { dates, olderDropped } = occurrencesFor(monthly("2020-01-15"), "2026-09-15");
    expect(dates[0]).toBe("2025-09-15");
    expect(dates).toHaveLength(13); // 2025-09-15 .. 2026-09-15
    expect(olderDropped).toBe(true);
  });

  /**
   * The cap keeps the MOST RECENT 24, not the first 24 found. Twelve months of
   * a weekly rule is ~52 occurrences, so this binds routinely — and truncating
   * the wrong end would offer a ten-month-old occurrence while hiding last
   * week's.
   */
  it("keeps the 24 most recent when the cap binds", () => {
    const { dates, olderDropped } = occurrencesFor(
      { anchorOn: "2025-09-15", intervalUnit: "weekly", endsOn: null },
      "2026-09-15",
    );
    expect(dates).toHaveLength(24);
    expect(dates[dates.length - 1]).toBe("2026-09-15");
    expect(olderDropped).toBe(true);
  });

  it("does not claim older ones were dropped when none were", () => {
    expect(occurrencesFor(monthly("2026-07-01"), "2026-09-01").olderDropped).toBe(false);
  });
});

describe("dueOccurrences", () => {
  it("omits handled dates and keeps the rest", () => {
    const { dates } = dueOccurrences(
      monthly("2026-07-01"),
      "2026-09-01",
      new Set(["2026-08-01"]),
    );
    expect(dates).toEqual(["2026-07-01", "2026-09-01"]);
  });

  it("leaves an earlier occurrence due when a later one is handled", () => {
    // Record August while July is outstanding: July stays due (spec §1.3).
    const { dates } = dueOccurrences(
      monthly("2026-07-01"),
      "2026-08-01",
      new Set(["2026-08-01"]),
    );
    expect(dates).toEqual(["2026-07-01"]);
  });

  it("reports nothing due when every occurrence is handled", () => {
    const { dates } = dueOccurrences(
      monthly("2026-08-01"),
      "2026-08-01",
      new Set(["2026-08-01"]),
    );
    expect(dates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/lib/recurrence.test.ts`
Expected: FAIL — `Failed to resolve import "./recurrence"`.

- [ ] **Step 3: Implement**

```ts
/**
 * Recurrence arithmetic for recurring rules. Pure, database-free, and
 * deliberately string-in/string-out over `YYYY-MM-DD` calendar dates.
 *
 * NEVER build a Date from local components here. src/lib/month-range.ts
 * documents a shipped Critical bug where `new Date(y, m, 1)` (local midnight)
 * read back via `.toISOString()` (UTC) shifted a month window by a day in
 * UTC+8. `anchor_on`, `ends_on` and `occurred_on` are all plain `date`
 * columns with no timezone, so every calculation below is either integer
 * maths or a strictly UTC Date round trip — UTC has no DST and no offset, so
 * it cannot shift a calendar date.
 */

export type RecurInterval = "weekly" | "fortnightly" | "monthly" | "yearly";

export type RecurrenceRule = {
  anchorOn: string;
  intervalUnit: RecurInterval;
  endsOn: string | null;
};

export type Occurrences = {
  dates: string[];
  /** True when the twelve-month floor or the 24 cap withheld an occurrence.
   *  The UI must say so: silent truncation reads as "you are up to date". */
  olderDropped: boolean;
};

/** Most recent occurrences offered at once (spec §1.5). */
const MAX_OCCURRENCES = 24;
/** How far back due occurrences reach (spec §1.5). */
const LOOKBACK_MONTHS = 12;

type Parts = { y: number; m: number; d: number };

function parse(iso: string): Parts {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

function format({ y, m, d }: Parts): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Days in a month, via a UTC probe of "day 0 of the next month". */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(iso: string, days: number): string {
  const { y, m, d } = parse(iso);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return format({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

/** Add whole months, clamping the day to the target month's length: the 31st
 *  becomes the 28th in February WITHOUT the anchor moving (see `nth`). */
function addMonthsClamped(iso: string, months: number): string {
  const { y, m, d } = parse(iso);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return format({ y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) });
}

/**
 * The nth occurrence, ALWAYS measured from the anchor. Never from the previous
 * occurrence: 31 Jan advanced month-by-month gives 28 Feb then 28 Mar, and the
 * rule has silently left the 31st forever (spec §3.1).
 */
function nth(rule: RecurrenceRule, n: number): string {
  switch (rule.intervalUnit) {
    case "weekly":
      return addDays(rule.anchorOn, 7 * n);
    case "fortnightly":
      return addDays(rule.anchorOn, 14 * n);
    case "monthly":
      return addMonthsClamped(rule.anchorOn, n);
    case "yearly":
      return addMonthsClamped(rule.anchorOn, 12 * n);
  }
}

export function occurrencesFor(rule: RecurrenceRule, today: string): Occurrences {
  const floorDate = addMonthsClamped(today, -LOOKBACK_MONTHS);
  const floor = floorDate > rule.anchorOn ? floorDate : rule.anchorOn;

  const kept: string[] = [];
  let dropped = false;

  // Bounded independently of the loop condition: a corrupt anchor must not
  // spin forever. Twelve months of a weekly rule is ~53, so 600 is far above
  // anything reachable while still being finite.
  for (let n = 0; n < 600; n++) {
    const d = nth(rule, n);
    if (d > today) break;
    if (rule.endsOn !== null && d > rule.endsOn) break;
    if (d < floor) {
      dropped = true;
      continue;
    }
    kept.push(d);
  }

  if (kept.length > MAX_OCCURRENCES) {
    // The MOST RECENT, not the first found: truncating the other end would
    // hide last week's occurrence behind one from ten months ago.
    return { dates: kept.slice(-MAX_OCCURRENCES), olderDropped: true };
  }
  return { dates: kept, olderDropped: dropped };
}

/**
 * Due = generated minus handled. `handled` holds the occurrence dates that
 * already have a non-deleted transaction or a skip row, so Record and Skip
 * work in any order — recording August leaves July due.
 */
export function dueOccurrences(
  rule: RecurrenceRule,
  today: string,
  handled: ReadonlySet<string>,
): Occurrences {
  const all = occurrencesFor(rule, today);
  return { dates: all.dates.filter((d) => !handled.has(d)), olderDropped: all.olderDropped };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/lib/recurrence.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Prove the anti-drift test discriminates**

Temporarily change `nth`'s `monthly` case to advance from the previous
occurrence instead of the anchor, e.g. by replacing the body of
`occurrencesFor`'s loop with a running `d = addMonthsClamped(d, 1)`. Re-run.

Expected: the "returns to the 31st in March" test FAILS with
`expected '2026-03-28' to be '2026-03-31'`. Restore, re-run, confirm green.
Record both observed outputs in your report — a drift test that cannot
observe drift is the defect this step exists to rule out.

- [ ] **Step 6: Commit**

```bash
git add src/lib/recurrence.ts src/lib/recurrence.test.ts
git commit -m "feat: add recurrence date arithmetic

Occurrences are computed as the nth step from the anchor, never advanced
from the previous one -- the latter moves a month-end rule off its anchor
permanently after one short February. All arithmetic is integer or strictly
UTC; local Date construction is what shifted month-range's window by a day."
```

---

### Task 2: Schema, constraints and RLS

**Files:**
- Create: `supabase/migrations/0015_recurring.sql`
- Modify: `supabase/tests/constraints.sql`, `supabase/tests/rls.sql`

**Interfaces:**
- Consumes: `is_wallet_member(uuid)` from `0004_rls.sql`; `txn_kind` enum and
  the `transactions` table from `0003_transactions.sql`.
- Produces: tables `recurring_rules`, `recurring_skips`; column
  `transactions.recurring_id`; enum `recur_interval`.

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Apply it and confirm the stack accepts it**

Run: `npx supabase db reset`
Expected: completes with no error, applying `0015_recurring.sql` last.

- [ ] **Step 3: Add constraint tests**

Append to `supabase/tests/constraints.sql`, following that file's existing
style of asserting each rejection by its constraint name:

```sql
\echo '--- recurring_rules: sign must follow kind ---'
do $$
begin
  begin
    insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                                 category_id, interval_unit, anchor_on)
    values (test_wallet_id(), 'Bad', 'expense', 500, 'USD', test_category_id(),
            'monthly', current_date);
    raise exception 'expected rule_expense_is_negative to reject a positive expense';
  exception when check_violation then
    assert sqlerrm like '%rule_expense_is_negative%',
      format('wrong constraint fired: %s', sqlerrm);
  end;
end $$;

\echo '--- recurring_rules: a transfer rule is refused outright ---'
do $$
begin
  begin
    insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                                 category_id, interval_unit, anchor_on)
    values (test_wallet_id(), 'Bad', 'transfer', -500, 'USD', test_category_id(),
            'monthly', current_date);
    raise exception 'expected rule_kind_not_transfer to reject a transfer rule';
  exception when check_violation then
    assert sqlerrm like '%rule_kind_not_transfer%',
      format('wrong constraint fired: %s', sqlerrm);
  end;
end $$;

\echo '--- recurring_rules: ends_on cannot precede the anchor ---'
do $$
begin
  begin
    insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                                 category_id, interval_unit, anchor_on, ends_on)
    values (test_wallet_id(), 'Bad', 'expense', -500, 'USD', test_category_id(),
            'monthly', '2026-06-01', '2026-05-01');
    raise exception 'expected rule_ends_after_anchor to reject an earlier end';
  exception when check_violation then
    assert sqlerrm like '%rule_ends_after_anchor%',
      format('wrong constraint fired: %s', sqlerrm);
  end;
end $$;

\echo '--- one occurrence cannot be recorded twice ---'
do $$
declare r uuid;
begin
  insert into recurring_rules (wallet_id, name, kind, amount_minor, currency_code,
                               category_id, interval_unit, anchor_on)
  values (test_wallet_id(), 'Rent', 'expense', -150000, 'USD', test_category_id(),
          'monthly', '2026-01-01')
  returning id into r;

  insert into transactions (wallet_id, kind, amount_minor, currency_code,
                            category_id, occurred_on, recurring_id)
  values (test_wallet_id(), 'expense', -150000, 'USD', test_category_id(),
          '2026-01-01', r);

  begin
    insert into transactions (wallet_id, kind, amount_minor, currency_code,
                              category_id, occurred_on, recurring_id)
    values (test_wallet_id(), 'expense', -150000, 'USD', test_category_id(),
            '2026-01-01', r);
    raise exception 'expected the partial unique index to refuse a second record';
  exception when unique_violation then
    assert sqlerrm like '%transactions_recurring_occurrence%',
      format('wrong index fired: %s', sqlerrm);
  end;

  -- Soft-deleting the first frees the occurrence again: the index is partial
  -- on deleted_at, which is what makes an undone Record re-recordable.
  update transactions set deleted_at = now()
   where recurring_id = r and occurred_on = '2026-01-01';
  insert into transactions (wallet_id, kind, amount_minor, currency_code,
                            category_id, occurred_on, recurring_id)
  values (test_wallet_id(), 'expense', -150000, 'USD', test_category_id(),
          '2026-01-01', r);
end $$;
```

Read `supabase/tests/constraints.sql` first and reuse its existing fixture
helpers rather than the placeholder names `test_wallet_id()` /
`test_category_id()` above if that file names them differently — match the
file, do not introduce a second convention.

- [ ] **Step 4: Add RLS tests**

Append to `supabase/tests/rls.sql`, following that file's existing
impersonation style (`set local role authenticated` plus a JWT claim):

```sql
\echo '--- a non-member sees no rules and can create none ---'
-- As user B, with a rule owned by user A's wallet in place:
--   select count(*) from recurring_rules  ->  MUST be 0
--   insert into recurring_rules (... A's wallet ...)  ->  MUST raise
--   insert into recurring_skips (... A's rule ...)    ->  MUST raise
\echo '--- a co-member of a shared wallet sees the rule and may skip it ---'
--   select count(*) from recurring_rules  ->  MUST be 1
--   insert into recurring_skips (... that rule ...)   ->  MUST succeed
```

Write these as real assertions in the file's own style — the comments above
name the required outcomes, not the syntax. The load-bearing one is the
**co-member CAN skip**: a suite that only proves a stranger is blocked cannot
tell a correct membership policy from one that denies everybody.

- [ ] **Step 5: Run both SQL suites**

Run: `npm run test:constraints && npm run test:rls`
Expected: PASS. Both are loopback-only; never point them at a hosted database.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0015_recurring.sql supabase/tests
git commit -m "feat(db): add recurring_rules, recurring_skips and transactions.recurring_id

Occurrence dates are computed, not stored. The partial unique index on
(recurring_id, occurred_on) makes Record idempotent against a double tap or
two tabs, and is partial on deleted_at so an undone Record can be redone.
recurring_id is ON DELETE SET NULL, never cascade: deleting a rule must not
delete money that was actually spent."
```

---

### Task 3: Validation and rule CRUD actions

**Files:**
- Create: `src/lib/validation/recurring.ts`, `src/lib/validation/recurring.test.ts`
- Create: `src/server/actions/recurring.ts`, `src/server/actions/recurring.test.ts`

**Interfaces:**
- Consumes: `RecurInterval` from `src/lib/recurrence.ts`; `parseAmountInput` /
  `minorUnitFor` from `src/lib/money.ts`.
- Produces:
  ```ts
  export type RecurringState = { error?: string; field?: RecurringField };
  export async function createRule(prev: RecurringState, fd: FormData): Promise<RecurringState>;
  export async function updateRule(id: string, prev: RecurringState, fd: FormData): Promise<RecurringState>;
  export async function archiveRule(id: string): Promise<RecurringState>;
  ```

- [ ] **Step 1: Write the failing validation tests**

```ts
import { describe, it, expect } from "vitest";
import { recurringInput } from "./recurring";

const base = {
  name: "Rent",
  kind: "expense",
  amount: "1500.00",
  currency_code: "SGD",
  category_id: "8f2b1c4e-0000-4000-8000-000000000000",
  wallet_id: "8f2b1c4e-1111-4000-8000-000000000000",
  interval_unit: "monthly",
  anchor_on: "2026-09-01",
  ends_on: "",
};

describe("recurringInput", () => {
  it("accepts a well-formed monthly expense", () => {
    expect(recurringInput.safeParse(base).success).toBe(true);
  });

  it("treats an empty end date as no end, not as an invalid date", () => {
    const parsed = recurringInput.parse(base);
    expect(parsed.ends_on).toBeNull();
  });

  it("refuses a transfer rule", () => {
    // Out of scope (spec §1.2), and refused here as well as by the CHECK
    // constraint, so the user sees a message rather than a database error.
    const r = recurringInput.safeParse({ ...base, kind: "transfer" });
    expect(r.success).toBe(false);
  });

  it("refuses an end date before the anchor", () => {
    const r = recurringInput.safeParse({ ...base, anchor_on: "2026-09-01", ends_on: "2026-08-01" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]!.message).toMatch(/end.*after|before/i);
  });

  it("refuses a fraction the currency cannot hold", () => {
    const r = recurringInput.safeParse({ ...base, currency_code: "JPY", amount: "12.5" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]!.message).toMatch(/no decimal places/i);
  });

  it("refuses a blank name", () => {
    expect(recurringInput.safeParse({ ...base, name: "   " }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/lib/validation/recurring.test.ts`
Expected: FAIL — cannot resolve `./recurring`.

- [ ] **Step 3: Implement the schema**

Model it on `src/lib/validation/wallet.ts`: a `z.object` plus a `superRefine`
for the cross-field rules. Required behaviour:

- `name` trimmed, 1–60 chars.
- `kind` restricted to `"expense" | "income"` — do NOT reuse the full
  `txn_kind` enum, which includes `transfer`.
- `amount` a free-text decimal string; reject a fraction longer than
  `minorUnitFor(currency_code)` allows, with the same message wording
  `wallet.ts` uses (`"<CODE> has no decimal places — enter a whole number."` /
  `"<CODE> allows up to N decimal place(s)."`). Do not truncate silently.
- `interval_unit` one of the four `RecurInterval` values.
- `anchor_on` a `YYYY-MM-DD` string.
- `ends_on` — empty string coerces to `null`; otherwise a date that must be
  `>= anchor_on`.
- Export `RecurringField = keyof z.infer<typeof recurringInput>` derived from
  the schema's own keys, as `wallet.ts` does, so a rename cannot desync it.

- [ ] **Step 4: Run the validation tests and watch them pass**

Run: `npx vitest run src/lib/validation/recurring.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing action tests**

Model the mock harness on `src/server/actions/wallets.test.ts` — `vi.hoisted`
for the Supabase client, `vi.mock("next/cache")`, and a spy that captures the
INSERT payload. The assertions that matter:

```ts
it("stores an expense amount as NEGATIVE minor units", async () => {
  await createRule({}, form({ kind: "expense", amount: "1500.00" }));
  expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ amount_minor: -150000 }));
});

it("stores an income amount as POSITIVE minor units", async () => {
  await createRule({}, form({ kind: "income", amount: "3200.00" }));
  expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ amount_minor: 320000 }));
});

it("never writes a transfer rule, however the form is posted", async () => {
  const res = await createRule({}, form({ kind: "transfer" }));
  expect(res.error).toBeTruthy();
  expect(insertSpy).not.toHaveBeenCalled();
});

it("archives rather than deleting, so recorded history is untouched", async () => {
  await archiveRule(RULE_ID);
  expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ archived_at: expect.anything() }));
});
```

- [ ] **Step 6: Implement the actions**

`createRule` / `updateRule` parse with `recurringInput`, convert the amount via
`parseAmountInput(amount, minorUnitFor(currency_code))` and **apply the sign
from `kind`** (negative for expense, positive for income) so the row satisfies
the CHECK constraints. `archiveRule` sets `archived_at`. All three
`revalidatePath("/", "layout")` and `revalidatePath("/recurring")`.

Follow `src/server/actions/wallets.ts` for shape: return `{ error }`, never
throw; select the affected ids back and treat an empty result as "not found",
the way `archiveCategory` and `archiveWallet` do — a zero-row UPDATE is not an
error in Postgres and would otherwise be reported to the user as success.

- [ ] **Step 7: Run the action tests and watch them pass**

Run: `npx vitest run src/server/actions/recurring.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/validation/recurring.ts src/lib/validation/recurring.test.ts \
        src/server/actions/recurring.ts src/server/actions/recurring.test.ts
git commit -m "feat: validate and manage recurring rules

kind is restricted to expense|income in the schema, not merely in the form:
a Server Function is reachable by direct POST. The amount's sign is applied
from the kind so a row can never violate 0003's own sign constraints."
```

---

### Task 4: Recording and skipping an occurrence

The write path. Everything else in this feature is display.

**Files:**
- Modify: `src/server/actions/recurring.ts`, `src/server/actions/recurring.test.ts`

**Interfaces:**
- Consumes: `createRule` et al. from Task 3.
- Produces:
  ```ts
  export async function recordOccurrence(ruleId: string, occurrenceOn: string): Promise<RecurringState>;
  export async function skipOccurrence(ruleId: string, occurrenceOn: string): Promise<RecurringState>;
  export async function unskipOccurrence(ruleId: string, occurrenceOn: string): Promise<RecurringState>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("dates the transaction to the OCCURRENCE, not to today", async () => {
  // The whole of spec §1.3 rests on this. Recording July's rent in September
  // must produce a 1 July transaction, or "each lands on its own date" is
  // cosmetic and July's report is still wrong.
  await recordOccurrence(RULE_ID, "2026-07-01");
  expect(insertSpy).toHaveBeenCalledWith(
    expect.objectContaining({ occurred_on: "2026-07-01", recurring_id: RULE_ID }),
  );
});

it("copies the rule's kind, amount, currency, category and wallet", async () => {
  await recordOccurrence(RULE_ID, "2026-07-01");
  expect(insertSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "expense",
      amount_minor: -150000,
      currency_code: "SGD",
      category_id: CATEGORY_ID,
      wallet_id: WALLET_ID,
    }),
  );
});

it("refuses to record against an archived wallet, with a readable reason", async () => {
  walletRow.archived_at = "2026-06-01T00:00:00Z";
  const res = await recordOccurrence(RULE_ID, "2026-07-01");
  expect(res.error).toMatch(/archived/i);
  expect(insertSpy).not.toHaveBeenCalled();
});

it("reports a duplicate record as already done, not as a crash", async () => {
  // The partial unique index is the real guard (two tabs, a double tap, a
  // retry). The user must see something sane rather than a Postgres error.
  insertResult.error = { code: "23505", message: "duplicate key" };
  const res = await recordOccurrence(RULE_ID, "2026-07-01");
  expect(res.error).toMatch(/already recorded/i);
});

it("skips idempotently", async () => {
  insertResult.error = { code: "23505", message: "duplicate key" };
  const res = await skipOccurrence(RULE_ID, "2026-07-01");
  // Skipping twice is the same as skipping once — the composite PK says so,
  // and the user should not see an error for reaching the state they wanted.
  expect(res).toEqual({});
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/server/actions/recurring.test.ts`
Expected: FAIL — `recordOccurrence is not a function`.

- [ ] **Step 3: Implement**

`recordOccurrence` loads the rule (RLS scopes it), verifies the wallet is
active and the category kind matches — the same checks
`src/server/actions/transactions.ts:104` and `:147` make for manual entry —
then inserts one transaction with `occurred_on = occurrenceOn` and
`recurring_id = ruleId`. Map Postgres `23505` to `"This occurrence is already
recorded."` rather than surfacing the driver's message.

`skipOccurrence` inserts into `recurring_skips`; treat `23505` as success.
`unskipOccurrence` deletes that row.

All three `revalidatePath("/", "layout")` — the dashboard's due list and its
figures both change.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/server/actions/recurring.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the date test discriminates**

Temporarily change `recordOccurrence` to use today's date instead of
`occurrenceOn`. Re-run; the "dates the transaction to the OCCURRENCE" test must
FAIL. Restore and confirm green. Paste both outputs into your report.

- [ ] **Step 6: Commit**

```bash
git add src/server/actions/recurring.ts src/server/actions/recurring.test.ts
git commit -m "feat: record and skip recurring occurrences

A recorded occurrence is dated to the occurrence, never to today -- July's
rent recorded in September belongs in July. Duplicate inserts are reported
as 'already recorded' rather than surfacing a unique-violation, since the
index exists precisely to absorb a double tap or a second tab."
```

---

### Task 5: The /recurring management screen

**Files:**
- Create: `src/app/(app)/recurring/page.tsx`, `src/app/(app)/recurring/RecurringList.tsx`,
  `src/app/(app)/recurring/RecurringForm.tsx`
- Create: `src/app/(app)/recurring/RecurringList.test.tsx`, `src/app/(app)/recurring/RecurringForm.test.tsx`
- Modify: `src/app/(app)/transactions/page.tsx` (add the link)

**Interfaces:**
- Consumes: `createRule`, `updateRule`, `archiveRule` (Task 3);
  `RecurInterval` (Task 1).
- Produces: the route `/recurring`.

- [ ] **Step 1: Write the failing list tests**

```ts
it("describes each rule in words, not codes", () => {
  render(<RecurringList rules={[rule({ name: "Rent", intervalUnit: "monthly", anchorOn: "2026-09-01" })]} />);
  expect(screen.getByText("Rent")).toBeInTheDocument();
  expect(screen.getByText(/monthly on the 1st/i)).toBeInTheDocument();
});

it("states an end date when the rule has one, and says nothing when it does not", () => {
  const { unmount } = render(<RecurringList rules={[rule({ endsOn: "2027-01-01" })]} />);
  expect(screen.getByText(/until 1 Jan 2027/i)).toBeInTheDocument();
  unmount();
  render(<RecurringList rules={[rule({ endsOn: null })]} />);
  expect(screen.queryByText(/until/i)).not.toBeInTheDocument();
});

it("renders an empty state rather than an empty list", () => {
  render(<RecurringList rules={[]} />);
  expect(screen.getByText(/nothing recurring yet/i)).toBeInTheDocument();
});

it("names Pause after the rule it pauses", () => {
  // Several rows each render a Pause control; by visible text alone they are
  // indistinguishable to anyone navigating by accessible name.
  render(<RecurringList rules={[rule({ name: "Spotify" })]} />);
  expect(screen.getByRole("button", { name: "Pause Spotify" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run "src/app/(app)/recurring"`
Expected: FAIL — cannot resolve the components.

- [ ] **Step 3: Implement the page, list and form**

`page.tsx` is a Server Component: read `recurring_rules` (RLS-scoped, filtered
`archived_at is null`) plus the caller's wallets and categories, and pass them
down. Follow `src/app/(app)/wallets/page.tsx` for the shape — including
throwing on a query error rather than rendering an empty list, which would
otherwise show "nothing recurring yet" on a transient database blip.

`RecurringForm` follows `src/components/WalletForm.tsx`: `useActionState`, an
always-mounted `role="alert"` that receives focus when an error appears, and a
`Pause`/archive control named after its rule.

The human-readable schedule ("monthly on the 1st", "every 2 weeks from 3 Sep",
"until 1 Jan 2027") belongs in a small exported pure helper in
`RecurringList.tsx` so it can be unit-tested without rendering.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run "src/app/(app)/recurring" && npm run typecheck && npm run lint`
Expected: PASS, 0 type errors, 0 lint errors.

- [ ] **Step 5: Link it from /transactions**

Add a plain link to `/recurring` on `src/app/(app)/transactions/page.tsx`.
This is the route's permanent home: the dashboard's due section (Task 6)
disappears when nothing is due, which is exactly when a user goes looking to
create a rule, so it cannot be the only entry point.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/recurring" "src/app/(app)/transactions/page.tsx"
git commit -m "feat: add the /recurring management screen

Linked from /transactions, not from a nav tab: the mobile tab bar was just
reduced from six items to five to stop wallet names truncating."
```

---

### Task 6: The dashboard DUE section

**Files:**
- Create: `src/components/DueList.tsx`, `src/components/DueList.test.tsx`
- Create: `src/app/(app)/due-rows.ts`, `src/app/(app)/due-rows.test.ts`
- Create: `src/lib/today.ts` (extracted, see Step 4)
- Modify: `src/app/(app)/page.tsx`, `src/components/TransactionForm.tsx:35`

**Interfaces:**
- Consumes: `dueOccurrences` (Task 1); `recordOccurrence`, `skipOccurrence`
  (Task 4).
- Produces:
  ```ts
  export type DueRow = {
    ruleId: string; ruleName: string; occurrenceOn: string;
    amountMinor: number; currencyCode: string; walletName: string;
    blockedReason: string | null;
  };
  export function buildDueRows(input: {...}, today: string): { rows: DueRow[]; olderDropped: boolean };
  ```

- [ ] **Step 1: Write the failing tests for the data boundary**

```ts
it("returns one row per due occurrence, oldest first", () => {
  // Oldest first: the backlog reads as a queue to work through, and the
  // oldest is the one most at risk of being forgotten.
  const { rows } = buildDueRows(input, "2026-09-01");
  expect(rows.map((r) => r.occurrenceOn)).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
});

it("omits occurrences already recorded or skipped", () => { /* ... */ });

it("marks a rule whose wallet is archived as blocked, rather than hiding it", () => {
  // Hiding it would leave the user wondering where their rule went;
  // recordOccurrence would refuse anyway, so the reason is stated up front.
  const { rows } = buildDueRows(archivedWalletInput, "2026-09-01");
  expect(rows[0]!.blockedReason).toMatch(/archived/i);
});

it("reports when the backstop withheld older occurrences", () => {
  const { olderDropped } = buildDueRows(longRunningInput, "2026-09-01");
  expect(olderDropped).toBe(true);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run "src/app/(app)/due-rows.test.ts"`
Expected: FAIL — cannot resolve `./due-rows`.

- [ ] **Step 3: Implement `buildDueRows` and `DueList`**

`buildDueRows` is pure: rules + skips + already-recorded `(rule, date)` pairs +
`today` in, `DueRow[]` out. Put it in its own module for the same reason
`wallet-rows.ts` exists — so it is unit-testable without a Supabase stack.

`DueList` renders the rows with Record and Skip per row, each named after both
the rule and the date (`Record Rent for 1 July`) — several rows carry the same
verb, and the accessible name is what distinguishes them. A blocked row renders
its reason instead of its buttons. When `olderDropped` is true, the list says
so; it must never silently imply the user is up to date.

- [ ] **Step 4: Wire it into the dashboard**

In `src/app/(app)/page.tsx`, read the rules, skips and recorded occurrences,
build the rows, and render `<DueList>` **above the hero total**. Render
**nothing at all** when there are no due rows — not an empty state, not a
"you're all caught up" card. The dashboard is opened many times a day and most
of those times nothing is owed.

`today` must be the USER'S LOCAL calendar day, never
`new Date().toISOString()` — that is a UTC re-interpretation of a local
moment, and at 01:00 in Kuwait (UTC+3) it yields *yesterday*, which would
hide an occurrence that is due.

`todayLocalDate()` already exists with exactly this behaviour and this
reasoning, but it is a **private function inside
`src/components/TransactionForm.tsx:35`**, not an export. Extract it to
`src/lib/today.ts` (carrying its doc comment, which explains the UTC trap)
and have `TransactionForm` import it from there. Do NOT copy it: two
divergent notions of "today" in one ledger app is precisely the bug class
this project has already been bitten by twice.

Note the dashboard is a Server Component, so this call runs on the SERVER,
whose local timezone is the deployment's, not the user's. That is a real
limitation shared with the existing month-range logic; it is out of scope
here, and you should not attempt to solve it in this task — but say so in
your report rather than leaving it unremarked.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS, 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/DueList.tsx src/components/DueList.test.tsx \
        "src/app/(app)/due-rows.ts" "src/app/(app)/due-rows.test.ts" "src/app/(app)/page.tsx"
git commit -m "feat: show due recurring occurrences on the dashboard

Absent entirely when nothing is due. A blocked rule states its reason rather
than vanishing, and the backstop says when it withheld older occurrences --
silent truncation reads as 'you are up to date'."
```

---

### Task 7: End-to-end proof

**Files:**
- Create: `e2e/recurring.spec.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the spec**

This repo's e2e files are deliberately self-contained — `e2e/budgets.spec.ts`
documents why — so duplicate `signUpAndOnboard`, `pressAmount` and
`expectNoViolations` rather than importing them.

The flow:

1. Sign up and onboard.
2. Go to `/recurring` **via the link on `/transactions`**, not `page.goto` —
   that link is the route's only permanent entry point and an unreachable
   management screen is the failure this step guards.
3. Create a monthly rule anchored **in the past** (e.g. the 1st of last month)
   so occurrences are already due.
4. Go to `/` and assert the DUE section lists the occurrence, named after the
   rule and its date.
5. Press Record.
6. **The load-bearing assertion:** go to `/transactions` and assert the new
   transaction is dated **the occurrence's date**, not today. Assert the
   dashboard's hero total moved only after recording.
7. Skip a second occurrence and assert it leaves the due list without creating
   a transaction.
8. `expectNoViolations` on `/` while the DUE section is populated.

- [ ] **Step 2: Prove step 6 discriminates**

Temporarily change `recordOccurrence` to use today's date. Re-run; the date
assertion must FAIL. Restore, re-run green. Paste the actual failure output
into your report — a test that only checked "a transaction appeared" would pass
with the entire dating rule broken.

- [ ] **Step 3: Run the full suites**

Run: `npm test && npx playwright test && npm run typecheck && npm run lint && npm run build`
Expected: all pass, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add e2e/recurring.spec.ts
git commit -m "test(e2e): prove a recorded occurrence is dated to its own date"
```

---

## Self-Review

**Spec coverage.** §1.1 confirm-to-record → Tasks 4 and 6 (no scheduler
anywhere in the plan). §1.2 expense/income only → Task 2's
`rule_kind_not_transfer` CHECK plus Task 3's schema restriction, belt and
braces because a Server Function is reachable by direct POST. §1.3 every
occurrence listed separately → Task 1's `dueOccurrences` and Task 6's
oldest-first rows; the "record August, July stays due" case is tested in Task
1. §1.4 optional `ends_on` → Task 2's column and CHECK, Task 3's validation.
§1.5 backstop → Task 1's floor, cap and `olderDropped`, surfaced in Task 6.
§2 data model → Task 2 verbatim. §3 computation → Task 1, including the
anti-drift and cap-direction cases. §4 record/skip → Task 4. §5 surfaces →
Tasks 5 and 6, with the dual entry point for `/recurring`. §6 out of scope →
nothing in this plan implements transfers, forecasting, variable amounts or
notifications. §7 testing → distributed, with each named suite present.

**Placeholders.** Tasks 3, 5 and 6 specify behaviour and the files to model on
rather than complete JSX, because the components must match existing ones the
implementer has to read first (`WalletForm.tsx`, `wallet-rows.ts`); every value
they must hit — messages, accessible names, ordering — is pinned. The SQL and
the recurrence library, where correctness is subtle, are given in full.

**Type consistency.** `RecurInterval`, `RecurrenceRule`, `Occurrences` and
`DueRow` are spelled identically in Tasks 1, 3 and 6. `interval_unit` is the
column name everywhere (never `interval`, an SQL keyword). `occurrenceOn` is
the parameter name in Task 4 and the `DueRow` field in Task 6. `anchor_on` /
`anchorOn` follow the project's existing snake-case-in-SQL,
camelCase-in-TypeScript split.

**One gap accepted deliberately.** Task 2's RLS step names required outcomes
rather than full SQL, because `supabase/tests/rls.sql`'s impersonation
boilerplate must be matched exactly and is long; the implementer is told to
read that file and follow it. The outcomes themselves — including the
load-bearing "a co-member CAN skip" — are stated unambiguously.
