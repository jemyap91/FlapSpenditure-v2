# Wallet-Set Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A budget applies to a chosen set of accounts — one, several, or all — with all as the default, replacing the per-wallet-only model already on `main`.

**Architecture:** `budgets` is reshaped to carry no `wallet_id`; a `budget_wallets` join table holds its scope. Visibility is derived from that set rather than configured. Categories key on normalised name because category ids are wallet-scoped. `get_budget_status` keeps its name and parameters but returns one row per budget.

**Tech Stack:** Next.js 16 (App Router), Supabase Postgres with RLS, TypeScript strict, Tailwind, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-25-wallet-set-budgets-design.md` — read it; this plan argues from it and does not restate its reasoning.

## Global Constraints

- Budgets measure **expenses only**. Income and transfers never count. Enforced by `where t.kind = 'expense'` in `get_budget_status` and nowhere else.
- Money is `bigint` signed minor units. `parseFloat(x) * 100` is banned project-wide; use `parseAmountInput` with `minorUnitFor(currency_code)`.
- RLS is the security boundary. `is_wallet_member(uuid)` is the single membership predicate.
- SECURITY DEFINER functions must `set search_path = ''` with every name schema-qualified; `pg_temp` is searched first and is a hijack vector.
- Server actions are reachable by direct POST: re-derive the caller via `getUser()`, re-validate with zod, and **RETURN** errors, never throw.
- RLS turns "not yours" into zero rows, so deletes and updates must check affected rows.
- Never leak raw provider or database error text to the user.
- Any state a sighted user can infer from colour must survive being read aloud.
- Never derive a date string via `Date.toISOString()`. Use `monthRange()` from `@/lib/month-range`. `npm test` pins `TZ=Asia/Singapore` so this fails loudly.
- Run `npm run test:constraints` and `npm run test:rls` **sequentially** — both reset the same local database.
- Never run a migration against a hosted database. Local only.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0013_wallet_set_budgets.sql` | Reshape `budgets`, add `budget_wallets`, RLS, grants, `get_budget_status`, `set_budget` |
| `supabase/tests/constraints.sql` | CHECK/FK/duplicate invariants (append; replace the 0012 budgets section) |
| `supabase/tests/rls.sql` | Visibility, empty-set, non-member denials with paired positive controls |
| `src/lib/budget-status.ts` | Narrowed row type + `budgetProgress` + `scopeLabel` |
| `src/lib/validation/budget.ts` | Zod schema for amount and wallet-set input |
| `src/server/actions/budgets.ts` | `setBudget`, `removeBudget` |
| `src/app/(app)/budgets/BudgetList.tsx` | Budget-grouped list, inline edit, wallet picker |
| `src/app/(app)/budgets/page.tsx` | Server Component fetch |
| `src/components/BudgetSummary.tsx` | Dashboard block |
| `e2e/budgets.spec.ts` | Browser-level expenses-only proof and scope proof |

---

### Task 1: Migration 0013 — schema

**Files:**
- Create: `supabase/migrations/0013_wallet_set_budgets.sql`
- Modify: `supabase/tests/constraints.sql` (replace the budgets section added by 0012)

**Interfaces:**
- Consumes: `wallets(id, currency_code, archived_at)`, `is_wallet_member(uuid)`, `auth.users(id)`
- Produces: tables `budgets(id, created_by, currency_code, category_key, period_start, amount_minor, created_at)` and `budget_wallets(budget_id, wallet_id)`

- [ ] **Step 1: Write the migration**

`0012` is on `main` but was never pushed to the hosted database, so this drops
and recreates rather than altering. `cascade` removes `get_budget_status` and
`set_budget`, which Tasks 2 and 3 recreate with new signatures.

```sql
-- supabase/migrations/0013_wallet_set_budgets.sql

-- 0012 keyed a budget to exactly one wallet. A budget now carries a SET of
-- wallets (spec 2026-08-25). 0012 was never applied to the hosted database,
-- so this drops and recreates instead of migrating data. `cascade` also drops
-- get_budget_status and set_budget, both recreated with new shapes below.
drop table if exists budgets cascade;

create table budgets (
  id            uuid primary key default gen_random_uuid(),
  -- Provenance, NOT permission: who can see this budget is decided entirely
  -- by its wallet set (budgets_visible below), never by created_by.
  created_by    uuid not null references auth.users(id),
  -- Denormalised from the set's wallets, which must all share it. Stored so a
  -- budget is self-describing and so a primary-currency shift is visible
  -- rather than silently matching nothing.
  currency_code char(3) not null,
  -- lower(btrim(name)) of the category, or NULL for this set's overall cap.
  -- A NAME, not an id, because categories are wallet-scoped since 0008 and a
  -- budget spanning wallets has no single category row to reference.
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

create index budget_wallets_wallet on budget_wallets (wallet_id);

alter table budgets enable row level security;
alter table budget_wallets enable row level security;

-- A budget is visible to exactly those who can see ALL the money it covers.
-- One rule, no flag: a set of one shared wallet stays shared with that
-- wallet's members (0012's behaviour); a set spanning personal wallets is
-- personal. A budget covering a wallet you are not in is unrepresentable, so
-- it cannot surface figures derived from spending you cannot see.
--
-- HAZARD: `not exists` over zero rows is TRUE, so a budget with NO wallets
-- would be visible to everyone. set_budget (Task 3) refuses to create one and
-- get_budget_status (Task 2) ignores any that exists. This is the single
-- fails-open case in an otherwise fails-closed design; rls.sql tests it.
create policy budgets_visible on budgets for all to authenticated
using (
  not exists (
    select 1 from budget_wallets bw
    where bw.budget_id = budgets.id and not is_wallet_member(bw.wallet_id)
  )
)
with check (
  not exists (
    select 1 from budget_wallets bw
    where bw.budget_id = budgets.id and not is_wallet_member(bw.wallet_id)
  )
);

-- Gated on the wallet named in the row, so the join table cannot be read to
-- enumerate wallet ids belonging to other people.
create policy budget_wallets_member on budget_wallets for all to authenticated
using (is_wallet_member(wallet_id)) with check (is_wallet_member(wallet_id));

-- 0004's own comment: the default ACL gives `authenticated` no DML, so a
-- policy without a grant is dead code.
grant select, insert, delete on budgets to authenticated;
-- Column-restricted UPDATE, matching transactions_member and the fix made to
-- 0012: `using` sees the old row and `with check` the new one, both asking the
-- same question, so an unrestricted grant would let a member re-point a budget
-- by changing a column the policy cannot distinguish.
grant update (amount_minor) on budgets to authenticated;
grant select, insert, delete on budget_wallets to authenticated;
```

- [ ] **Step 2: Apply it**

Run: `npx supabase db reset`
Expected: `0001`–`0013` apply cleanly.

- [ ] **Step 3: Replace the budgets section of `supabase/tests/constraints.sql`**

Delete the 0012 budgets blocks (they reference `wallet_id` and `category_id`,
which no longer exist) and write these. Each must be watched failing by
temporarily removing the constraint it protects.

```sql
-- period_start must be the first of a month
do $$
begin
  begin
    insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'SGD', 'groceries', '2026-11-15', 50000);
    raise exception 'CONSTRAINT BROKEN: budgets accepted a mid-month period_start';
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    assert v_constraint = 'budgets_period_start_check',
      format('wrong constraint fired: %s', v_constraint);
  end;
end $$;

-- amount_minor must be positive: zero and negative
do $$
begin
  begin
    insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'SGD', 'groceries', '2026-11-01', 0);
    raise exception 'CONSTRAINT BROKEN: budgets accepted a zero amount';
  exception when check_violation then null;
  end;
  begin
    insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'SGD', 'groceries', '2026-11-01', -100);
    raise exception 'CONSTRAINT BROKEN: budgets accepted a negative amount';
  exception when check_violation then null;
  end;
end $$;

-- budget_wallets rejects a wallet that does not exist, and cascades on delete
do $$
declare v_budget uuid; v_rows int;
begin
  insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'SGD', 'groceries', '2026-11-01', 50000)
  returning id into v_budget;

  begin
    insert into public.budget_wallets (budget_id, wallet_id)
    values (v_budget, '00000000-0000-0000-0000-0000000000ff');
    raise exception 'CONSTRAINT BROKEN: budget_wallets accepted a nonexistent wallet';
  exception when foreign_key_violation then null;
  end;

  insert into public.budget_wallets (budget_id, wallet_id)
  values (v_budget, 'cccccccc-0000-0000-0000-000000000003');

  delete from public.budgets where id = v_budget;
  select count(*) into v_rows from public.budget_wallets where budget_id = v_budget;
  assert v_rows = 0, 'CASCADE BROKEN: budget_wallets rows survived their budget';
end $$;
```

Declare `v_constraint text;` in the first block's `declare` section.

- [ ] **Step 4: Watch each guard fail**

For each: comment the constraint out of `0013`, run `npx supabase db reset`,
run `npm run test:constraints`, confirm the guard fires, restore, re-run green.
Report the exact output for each.

- [ ] **Step 5: Verify and commit**

```bash
npx supabase db reset && npm run test:constraints && npm run test:rls
git add supabase/migrations/0013_wallet_set_budgets.sql supabase/tests/constraints.sql
git commit -m "feat(db): reshape budgets to carry a wallet set"
```

Note `npm run test:rls` will FAIL at this point if the 0012 budgets section
still references dropped columns. Delete that section now; Task 2 writes its
replacement.

---

### Task 2: `get_budget_status` over wallet sets

**Files:**
- Modify: `supabase/migrations/0013_wallet_set_budgets.sql` (append)
- Modify: `supabase/tests/rls.sql` (replace the budgets section)

**Interfaces:**
- Consumes: Task 1's tables
- Produces: `get_budget_status(from_date date, to_date date) returns table(budget_id uuid, category_key text, category_label text, currency_code char(3), wallet_names text[], wallet_count int, spent_minor bigint, budget_minor bigint, budget_period_start date)`

- [ ] **Step 1: Append the function**

```sql
-- One row per visible budget, plus one row per category with spending that no
-- visible budget covers. Self-scoping: no wallet-ids parameter, so there is no
-- caller-supplied filter to tamper with.
create function get_budget_status(from_date date, to_date date)
  returns table (
    budget_id uuid, category_key text, category_label text,
    currency_code char(3), wallet_names text[], wallet_count int,
    spent_minor bigint, budget_minor bigint, budget_period_start date
  )
  language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  with mine as (
    select w.id, w.name, w.currency_code
    from public.wallets w
    where public.is_wallet_member(w.id) and w.archived_at is null
  ),
  -- Visible AND non-empty. The non-empty test is what closes the fails-open
  -- hole in budgets_visible: `not exists` over zero rows is TRUE.
  vis as (
    select b.*
    from public.budgets b
    where exists (select 1 from public.budget_wallets bw where bw.budget_id = b.id)
      and not exists (
        select 1 from public.budget_wallets bw
        where bw.budget_id = b.id and not public.is_wallet_member(bw.wallet_id)
      )
  ),
  -- Canonical identity for a wallet SET, so carry-forward can ask "the most
  -- recent budget for THIS set and category" without a set-valued join key.
  keyed as (
    select v.id, v.category_key, v.period_start, v.amount_minor, v.currency_code,
           string_agg(bw.wallet_id::text, ',' order by bw.wallet_id) as set_key
    from vis v
    join public.budget_wallets bw on bw.budget_id = v.id
    where v.period_start <= from_date
    group by v.id, v.category_key, v.period_start, v.amount_minor, v.currency_code
  ),
  -- Carry-forward: the most recent row at or before the month, per set and
  -- category. A budget set in September governs October until another exists.
  eff as (
    select distinct on (k.set_key, k.category_key) k.*
    from keyed k
    order by k.set_key, k.category_key, k.period_start desc
  ),
  spend as (
    select e.id as budget_id, coalesce(sum(-t.amount_minor), 0)::bigint as spent
    from eff e
    join public.budget_wallets bw on bw.budget_id = e.id
    left join public.transactions t
      on t.wallet_id = bw.wallet_id
     and t.kind = 'expense'
     and t.deleted_at is null
     and t.occurred_on between from_date and to_date
    left join public.categories c on c.id = t.category_id
    where e.category_key is null
       or lower(btrim(c.name)) = e.category_key
    group by e.id
  ),
  scope as (
    select bw.budget_id, array_agg(m.name order by m.name) as names, count(*)::int as n
    from public.budget_wallets bw join mine m on m.id = bw.wallet_id
    group by bw.budget_id
  ),
  -- Spending in my wallets whose category no visible budget covers.
  uncovered as (
    select lower(btrim(c.name)) as key, min(c.name) as label,
           m.currency_code, sum(-t.amount_minor)::bigint as spent
    from public.transactions t
    join mine m on m.id = t.wallet_id
    join public.categories c on c.id = t.category_id
    where t.kind = 'expense' and t.deleted_at is null
      and t.occurred_on between from_date and to_date
      and not exists (select 1 from eff e where e.category_key = lower(btrim(c.name)))
    group by 1, 3
  )
  select e.id, e.category_key,
         coalesce((select min(c.name) from public.categories c
                   where lower(btrim(c.name)) = e.category_key), e.category_key),
         e.currency_code, s.names, s.n,
         sp.spent, e.amount_minor, e.period_start
  from eff e
  join spend sp on sp.budget_id = e.id
  join scope s on s.budget_id = e.id
  union all
  select null::uuid, u.key, u.label, u.currency_code, null::text[], null::int,
         u.spent, null::bigint, null::date
  from uncovered u;
end $$;

revoke all on function get_budget_status(date, date) from public, anon;
grant execute on function get_budget_status(date, date) to authenticated;
```

- [ ] **Step 2: Write the RLS suite's budgets section**

Replace what Task 1 deleted. Every denial gets a paired positive control.

Required blocks, each with a fixture you create in that section:
1. **Positive:** Alice creates a budget over her own wallet; `get_budget_status` returns it with the right `spent_minor` and `budget_minor`.
2. **Denial + positive:** Carol, a non-member, gets zero rows for that budget while Alice still gets one.
3. **Denial + positive:** a budget spanning `{Alice's wallet, Bob's wallet}` is invisible to Alice alone and to Bob alone, and visible to nobody who is not in both. Prove someone in both DOES see it.
4. **Empty-set:** insert a budget with no `budget_wallets` rows directly as superuser, then assert `get_budget_status` returns nothing for it as an ordinary member. Watch this fail by removing the `exists (...)` clause from `vis`.
5. **Expenses-only:** a wallet holding an expense, an income and a real `create_transfer` pair reports only the expense. Watch it fail by removing `t.kind = 'expense'`.
6. **Carry-forward:** September 50000, October raised to 80000; assert September still reports 50000 and November carries 80000.
7. **Overlap:** two budgets on the same category, one over `{A}` and one over `{A,B}`, both report independently and the same expense appears in both.

- [ ] **Step 3: Watch the two critical guards fail**

The empty-set guard and the expenses-only guard. Report exact output. If
either passes without its protection, STOP and report — it is not testing what
it claims.

- [ ] **Step 4: Verify and commit**

```bash
npx supabase db reset && npm run test:constraints && npm run test:rls
npm run db:types
git add supabase/migrations/0013_wallet_set_budgets.sql supabase/tests/rls.sql src/lib/database.types.ts
git commit -m "feat(db): scope get_budget_status to wallet sets"
```

---

### Task 3: `set_budget` write function

**Files:**
- Modify: `supabase/migrations/0013_wallet_set_budgets.sql` (append)
- Modify: `supabase/tests/constraints.sql` (append)

**Interfaces:**
- Consumes: Task 1's tables
- Produces: `set_budget(p_category_key text, p_period_start date, p_amount_minor bigint, p_wallet_ids uuid[]) returns uuid`

- [ ] **Step 1: Append the function**

```sql
-- Creating or updating a budget is multi-row (a budgets row plus one
-- budget_wallets row per wallet) and carries invariants a client cannot be
-- trusted with, so it lives here. security invoker, following create_transfer
-- (0005): RLS decides whether the write lands; the explicit guards exist for
-- readable errors, not as the boundary.
create function set_budget(
  p_category_key text, p_period_start date, p_amount_minor bigint, p_wallet_ids uuid[]
) returns uuid
  language plpgsql security invoker set search_path = '' as $$
declare
  v_currency char(3);
  v_count int;
  v_existing uuid;
  v_key text;
  v_id uuid;
begin
  if p_period_start is null or p_amount_minor is null or p_wallet_ids is null then
    raise exception 'period, amount and accounts must not be null';
  end if;
  if p_amount_minor <= 0 then
    raise exception 'budget amount must be positive';
  end if;
  -- The fails-open case: a budget with no wallets satisfies budgets_visible's
  -- `not exists` for EVERY user. Refused here; get_budget_status ignores any
  -- that exists anyway.
  if array_length(p_wallet_ids, 1) is null then
    raise exception 'a budget must cover at least one account';
  end if;

  select count(*) into v_count from public.wallets w
   where w.id = any(p_wallet_ids) and public.is_wallet_member(w.id);
  if v_count <> array_length(p_wallet_ids, 1) then
    raise exception 'not a member of every account in that set';
  end if;

  select count(distinct w.currency_code) into v_count from public.wallets w
   where w.id = any(p_wallet_ids);
  if v_count <> 1 then
    raise exception 'every account in a budget must use the same currency';
  end if;
  select distinct w.currency_code into v_currency from public.wallets w
   where w.id = any(p_wallet_ids);

  v_key := (select string_agg(x::text, ',' order by x) from unnest(p_wallet_ids) x);

  -- Uniqueness lives here rather than in an index: a wallet SET cannot be a
  -- unique index key without a trigger-maintained canonical column. A
  -- duplicate is no longer catastrophic (overlapping budgets are a feature,
  -- so it renders as two identical rows) but it is still an error.
  select b.id into v_existing
    from public.budgets b
   where b.period_start = p_period_start
     and b.category_key is not distinct from p_category_key
     and (select string_agg(bw.wallet_id::text, ',' order by bw.wallet_id)
            from public.budget_wallets bw where bw.budget_id = b.id) = v_key
   limit 1;

  if v_existing is not null then
    update public.budgets set amount_minor = p_amount_minor where id = v_existing;
    return v_existing;
  end if;

  insert into public.budgets (created_by, currency_code, category_key, period_start, amount_minor)
  values (auth.uid(), v_currency, p_category_key, p_period_start, p_amount_minor)
  returning id into v_id;

  insert into public.budget_wallets (budget_id, wallet_id)
  select v_id, x from unnest(p_wallet_ids) x;

  return v_id;
end $$;

revoke all on function set_budget(text, date, bigint, uuid[]) from public, anon;
grant execute on function set_budget(text, date, bigint, uuid[]) to authenticated;
```

- [ ] **Step 2: Append constraint tests**

Wrap in `begin / set local request.jwt.claims / commit` as the existing budgets
section does — `set_budget` resolves membership through `auth.uid()`, which is
NULL in `constraints.sql`'s superuser session otherwise.

Assert, each with a descriptive failure message:
1. An empty array is refused.
2. A set mixing two currencies is refused.
3. A set containing a wallet the caller is not a member of is refused.
4. Calling twice for the same category, set and month leaves **exactly one** row carrying the second amount — assert the row COUNT, not only the amount, since "updated" and "inserted a duplicate" are indistinguishable from the amount alone.
5. The same category and month over a DIFFERENT set creates a SECOND budget — overlap is allowed.

- [ ] **Step 3: Watch guards 1, 2 and 3 fail**

Comment out each guard in turn, re-run, confirm the assertion fires, restore.
Report exact output.

- [ ] **Step 4: Verify and commit**

```bash
npx supabase db reset && npm run test:constraints && npm run test:rls
npm run db:types
git add supabase/migrations/0013_wallet_set_budgets.sql supabase/tests/constraints.sql src/lib/database.types.ts
git commit -m "feat(db): add set_budget over a wallet set"
```

---

### Task 4: Pure helpers

**Files:**
- Modify: `src/lib/budget-status.ts`
- Modify: `src/lib/budget-status.test.ts`

**Interfaces:**
- Consumes: Task 2's return shape
- Produces: `BudgetStatusRow`; `budgetProgress(row)` unchanged; `scopeLabel(names: string[] | null, count: number | null, totalInCurrency: number): string`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { scopeLabel } from "@/lib/budget-status";

describe("scopeLabel", () => {
  it("names a single account outright", () => {
    expect(scopeLabel(["Everyday"], 1, 3)).toBe("Everyday");
  });

  it("joins two accounts, because the names still fit", () => {
    expect(scopeLabel(["Everyday", "Savings"], 2, 3)).toBe("Everyday + Savings");
  });

  it("counts beyond two rather than listing them", () => {
    expect(scopeLabel(["A", "B", "C"], 3, 5)).toBe("3 accounts");
  });

  it("says All accounts only when it really covers all of them", () => {
    expect(scopeLabel(["A", "B", "C"], 3, 3)).toBe("All accounts");
  });

  it("does NOT say All accounts once a new account exists outside it", () => {
    // The set is materialised at creation (spec §1), so a wallet added later
    // is not covered. Claiming "All accounts" here would be a false statement,
    // not merely a stale one.
    expect(scopeLabel(["A", "B", "C"], 3, 4)).toBe("3 accounts");
  });

  it("falls back for an unbudgeted row, which has no scope", () => {
    expect(scopeLabel(null, null, 3)).toBe("");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/lib/budget-status.test.ts`
Expected: FAIL — `scopeLabel` is not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * How a budget's wallet set reads on screen. "All accounts" is claimed ONLY
 * when the set covers every wallet in that currency — a set is materialised
 * when the budget is created (spec §1), so a wallet created afterwards is not
 * covered, and calling that "All accounts" would state something false rather
 * than merely stale.
 */
export function scopeLabel(
  names: string[] | null,
  count: number | null,
  totalInCurrency: number,
): string {
  if (!names || !count) return "";
  if (count === totalInCurrency) return "All accounts";
  if (count === 1) return names[0]!;
  if (count === 2) return `${names[0]} + ${names[1]}`;
  return `${count} accounts`;
}
```

Replace `BudgetStatusRow`'s narrowed fields to match Task 2's return columns:
`budget_id`, `wallet_names`, `wallet_count`, `budget_minor` and
`budget_period_start` are all nullable; `category_key` is nullable (the overall
cap); `category_label` is nullable only for the overall cap.

- [ ] **Step 4: Verify and commit**

```bash
npm test && npm run typecheck
git add src/lib/budget-status.ts src/lib/budget-status.test.ts
git commit -m "feat: add scope label derivation for wallet-set budgets"
```

---

### Task 5: Validation and server actions

**Files:**
- Modify: `src/lib/validation/budget.ts`, `src/lib/validation/budget.test.ts`
- Modify: `src/server/actions/budgets.ts`, `src/server/actions/budgets.test.ts`

**Interfaces:**
- Consumes: Task 3's `set_budget`; `parseAmountInput`, `minorUnitFor`; `monthRange`
- Produces: `setBudget(categoryKey: string | null, prev: BudgetState, formData: FormData): Promise<BudgetState>` reading `amount` and repeated `walletIds` from the form; `removeBudget(id: string): Promise<BudgetState>` unchanged

- [ ] **Step 1: Write the failing validation tests**

```ts
import { describe, expect, it } from "vitest";
import { budgetInput } from "@/lib/validation/budget";

describe("budgetInput", () => {
  it("accepts an amount with at least one account", () => {
    expect(budgetInput.safeParse({ amount: "600", walletIds: ["a"] }).success).toBe(true);
  });

  it("rejects an empty account set — it would be visible to everyone", () => {
    expect(budgetInput.safeParse({ amount: "600", walletIds: [] }).success).toBe(false);
  });

  it("rejects a negative amount", () => {
    expect(budgetInput.safeParse({ amount: "-50", walletIds: ["a"] }).success).toBe(false);
  });

  it("rejects letters", () => {
    expect(budgetInput.safeParse({ amount: "six", walletIds: ["a"] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/lib/validation/budget.test.ts`
Expected: FAIL — the schema has no `walletIds`.

- [ ] **Step 3: Implement the schema**

```ts
import { z } from "zod";

const AMOUNT_SHAPE = /^\d+(\.\d+)?$/;

export const budgetInput = z.object({
  amount: z.string().trim().min(1, "Enter an amount")
    .regex(AMOUNT_SHAPE, "Enter an amount like 600 or 600.50"),
  // At least one: an empty set satisfies budgets_visible's `not exists` for
  // every user, so it is refused here, in set_budget, and ignored by
  // get_budget_status. Three layers because it fails OPEN.
  walletIds: z.array(z.uuid()).min(1, "Choose at least one account"),
});
```

- [ ] **Step 4: Rewrite `setBudget`**

Read `formData.getAll("walletIds")`. Resolve the currency from the first
wallet and use `minorUnitFor` on it. Call:

```ts
const { error } = await supabase.rpc("set_budget", {
  p_category_key: categoryKey,
  p_period_start: monthRange().from,
  p_amount_minor: amountMinor,
  p_wallet_ids: parsed.data.walletIds,
});
if (error) return { error: "Could not save that budget. Please try again." };
revalidatePath("/budgets");
revalidatePath("/");
return { notice: "Budget saved." };
```

`removeBudget` is unchanged from `main` — including its zero-row check and its
uuid guard — except it must also `revalidatePath("/")` now that the dashboard
shows budgets.

- [ ] **Step 5: Write the action tests**

Mock `@/lib/supabase/server` and `next/cache` with `vi.hoisted` + `vi.mock`,
following `src/server/actions/invites.test.ts`. Cover: an empty wallet set is
refused before any RPC; a non-member set returns a readable message; the RPC
receives the exact `walletIds` array; a zero amount is refused; `removeBudget`
reports an error when it matches no row; both revalidate `/budgets` **and** `/`.

Write the empty-set test FIRST and watch it fail against a schema without
`.min(1)`.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/lib/validation/budget.ts src/lib/validation/budget.test.ts src/server/actions/budgets.ts src/server/actions/budgets.test.ts
git commit -m "feat: validate and write wallet-set budgets"
```

---

### Task 6: The `/budgets` screen

**Files:**
- Modify: `src/app/(app)/budgets/BudgetList.tsx`, `BudgetList.test.tsx`, `page.tsx`

**Interfaces:**
- Consumes: Tasks 2, 4, 5
- Produces: route `/budgets`, grouped by budget

**Accessible names — pinned, and Task 8 targets these exact strings.** Every one
renders once per row, so all selectors must be row-scoped.

| Control | Accessible name |
|---|---|
| Amount input | `Budget amount` |
| Submit | `Save budget` |
| Wallet picker | `Accounts this budget covers` |
| Category picker (new budget) | `Category` |
| Remove, category budget | `Remove budget for <category label>` |
| Remove, overall cap | `Remove overall budget` |
| Per-budget heading | an `<h2>` whose accessible name is `<category label> · <scope label>` |

- [ ] **Step 1: Write the failing component tests**

Cover, with rows supplied out of order:
1. A budgeted row renders `<spent> of <cap> · <n>%` and its scope label.
2. Over budget renders `Over by <amount>` **in words**, in its own paragraph.
3. A NULL `budget_minor` renders `<spent> spent · No budget set`, with no percent and no bar — with a positive control elsewhere asserting the bar IS present for a budgeted row.
4. Two budgets on the same category with different scopes render as two rows, each with its own scope label.
5. The `<h2>` is `level: 2` and named `<category> · <scope>`.

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

Group by budget, not wallet. Order: overall caps first, then budgeted
categories alphabetically, then uncovered spending. Reuse `budgetProgress`; do
not re-derive percentages. Render a disclosure when wallets in the budget's
currency are not covered by it, and one when wallets in other currencies are
excluded entirely — both in text.

`page.tsx` passes `totalInCurrency` (the count of the user's active wallets in
the primary currency) so `scopeLabel` can decide whether "All accounts" is true.

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck && npm run lint && npm test && npx playwright test e2e/ledger.spec.ts
git add "src/app/(app)/budgets"
git commit -m "feat: group the budgets screen by budget and its accounts"
```

---

### Task 7: Dashboard block

**Files:**
- Create: `src/components/BudgetSummary.tsx`, `src/components/BudgetSummary.test.tsx`
- Modify: `src/app/(app)/page.tsx`

**Interfaces:**
- Consumes: Task 2's `get_budget_status`, Task 4's `budgetProgress`

- [ ] **Step 1: Write the failing component test**

Assert: budgets covering all accounts appear; a budget over a subset does NOT
appear (the dashboard block is the all-accounts view); over-budget is stated in
words; an empty result renders a single explanatory line and no empty chrome.

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement and mount it**

Place after the cash-flow block. Reuse the dashboard's existing primary-currency
resolution and its existing exclusion disclosure — do not add a second one.

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck && npm run lint && npm test && npx playwright test
git add src/components/BudgetSummary.tsx src/components/BudgetSummary.test.tsx "src/app/(app)/page.tsx"
git commit -m "feat: show budget utilisation on the dashboard"
```

---

### Task 8: End-to-end proof

**Files:**
- Modify: `e2e/budgets.spec.ts`

- [ ] **Step 1: Rewrite the spec against the new screen**

Using the pinned names from Task 6, row-scoped throughout:
1. Create an all-accounts Groceries budget of 100 and record a 30 expense; assert `$30.00 of $100.00 · 30%`.
2. Record an income of 500 and a transfer; assert the figure does not move, **and** assert the rendered row count is unchanged — the row count is the load-bearing assertion, because a per-category figure cannot move (income cannot reach an expense category through the picker, the server check, or `transfer_shape`).
3. Record an 80 expense in a DIFFERENT category; assert the Groceries budget is unchanged and an uncovered row appears.
4. Create a second Groceries budget over one wallet only; assert both rows render with different scope labels and the same expense counts toward both.
5. Remove a budget by its pinned aria-label; assert the row falls back to uncovered spending.
6. `expectNoViolations` while the page is populated.

- [ ] **Step 2: Watch the expenses-only assertion fail**

Remove `t.kind = 'expense'` from `get_budget_status`, `npx supabase db reset`,
re-run. Confirm it fails. Report the exact figures. Restore and re-run green.
If it passes, STOP and report.

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npm run lint && npm test
npm run test:constraints && npm run test:rls
npx playwright test
git add e2e/budgets.spec.ts
git commit -m "test(e2e): prove wallet-set budgets count only expenses in their own accounts"
```

---

## Self-Review

**Spec coverage.** §1 schema → Task 1; "all wallets materialised" → Tasks 4 (label honesty) and 6 (disclosure); uniqueness in the write function → Task 3 Step 2.4; §2 name-keyed categories → Task 2's `category_key`; §3 visibility and the empty-set hazard → Task 1 policy, Task 2 `vis`, Task 3 guard, Task 5 schema — four layers, deliberate for the one fails-open case; §4 currency → Task 3 guard, Task 6 disclosure; §5 aggregate → Task 2; §6 UI → Tasks 6 and 7; §7 testing → distributed, with every denial paired; §8 out of scope → nothing here implements rollover, sub-allocation or conversion.

**Placeholders.** None. Tasks 6, 7 and 8 specify assertions and pinned names rather than full JSX, because the markup depends on rows Task 2 returns; every value those tasks must hit is pinned above.

**Type consistency.** `category_key`/`category_label`/`wallet_names`/`wallet_count`/`budget_period_start` are used identically in Tasks 2, 4, 6, 7 and 8. `set_budget`'s four parameters match Task 5's rpc call name-for-name. `scopeLabel`'s signature matches its call in Task 6.
