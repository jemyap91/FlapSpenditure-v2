# Wallet Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click a wallet, see its transactions, and add one to it without losing your place — plus rename the wallet-sense "account" to "wallet" throughout.

**Architecture:** A new `/wallets/[id]` Server Component route reusing the existing transaction list scoped to one wallet. `TransactionForm` gains an origin identifier (never a URL) so a save can return to the wallet it came from. The rename is by sense, not by string.

**Tech Stack:** Next.js 16 (App Router), Supabase Postgres with RLS, TypeScript strict, Tailwind, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-27-wallet-detail-design.md` — read it; this plan argues from it.

## Global Constraints

- Money is `bigint` signed minor units; `parseFloat(x) * 100` is banned project-wide.
- RLS is the security boundary. `is_wallet_member(uuid)` is the single membership predicate. A route must NOT add its own weaker check alongside RLS.
- Server actions are reachable by direct POST: re-derive the caller, re-validate with zod, RETURN errors rather than throw.
- **A redirect target must never come from user-supplied input.** Pass an origin IDENTIFIER; construct the path in code.
- Never derive a date string via `Date.toISOString()`. `npm test` pins `TZ=Asia/Singapore` so that mistake fails loudly.
- Any state a sighted user can infer from colour must survive being read aloud.
- A Server Component must not import a VALUE from a `"use client"` module — importing a const across that boundary yields `undefined` silently.
- Run `npm run test:constraints` and `npm run test:rls` SEQUENTIALLY if touched — both reset the same local database.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/origin.ts` | Parse `wallet:<uuid>` into a safe path; the open-redirect boundary |
| `src/app/(app)/wallets/[id]/page.tsx` | Wallet detail Server Component |
| `src/app/(app)/wallets/[id]/WalletFab.tsx` | Floating add-transaction button |
| `src/app/(app)/wallets/WalletList.tsx` | Wallet name becomes a link |
| `src/app/(app)/transactions/new/page.tsx` | Accepts `?wallet=` and `?from=` |
| `src/components/TransactionForm.tsx` | Preselects the wallet; redirects via the parsed origin |
| `src/app/(app)/budgets/BudgetList.tsx` | Select-all toggle; rename |

---

### Task 1: The origin parser

**Files:**
- Create: `src/lib/origin.ts`, `src/lib/origin.test.ts`

**Interfaces:**
- Produces: `parseOrigin(from: string | null | undefined): string` — returns a safe in-app path, defaulting to `/transactions`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseOrigin } from "@/lib/origin";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("parseOrigin", () => {
  it("turns a wallet origin into that wallet's path", () => {
    expect(parseOrigin(`wallet:${UUID}`)).toBe(`/wallets/${UUID}`);
  });

  it("falls back when absent", () => {
    expect(parseOrigin(null)).toBe("/transactions");
    expect(parseOrigin(undefined)).toBe("/transactions");
  });

  it("falls back on a malformed uuid rather than trusting it", () => {
    expect(parseOrigin("wallet:not-a-uuid")).toBe("/transactions");
    expect(parseOrigin("wallet:")).toBe("/transactions");
  });

  // The reason this function exists. Each of these is a redirect target a
  // caller could supply; none may ever become a destination.
  it("refuses an absolute URL", () => {
    expect(parseOrigin("https://evil.example")).toBe("/transactions");
  });

  it("refuses a protocol-relative URL", () => {
    expect(parseOrigin("//evil.example")).toBe("/transactions");
  });

  it("refuses a path, even an in-app one", () => {
    expect(parseOrigin("/wallets/abc")).toBe("/transactions");
    expect(parseOrigin("/admin")).toBe("/transactions");
  });

  it("refuses traversal", () => {
    expect(parseOrigin(`wallet:${UUID}/../admin`)).toBe("/transactions");
  });

  it("refuses an unknown origin kind", () => {
    expect(parseOrigin(`budget:${UUID}`)).toBe("/transactions");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/origin.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/origin"`.

- [ ] **Step 3: Implement**

```ts
import { z } from "zod";

const uuid = z.uuid();

/**
 * Turns an origin IDENTIFIER into an in-app path. The identifier comes from a
 * query string, so it is untrusted — and this function is the only reason a
 * user-supplied string can influence where the app navigates after a save.
 *
 * It never returns its input. It matches a known shape, validates the id, and
 * BUILDS the path itself. A value that is already a path or a URL is refused
 * precisely because accepting one is how open redirects happen: a same-origin
 * check on a supplied path filters a bad class, whereas constructing the path
 * removes it.
 */
export function parseOrigin(from: string | null | undefined): string {
  if (!from) return "/transactions";
  const [kind, ...rest] = from.split(":");
  if (kind !== "wallet") return "/transactions";
  const id = rest.join(":");
  if (!uuid.safeParse(id).success) return "/transactions";
  return `/wallets/${id}`;
}
```

- [ ] **Step 4: Run and watch it pass**

- [ ] **Step 5: Commit**

```bash
git add src/lib/origin.ts src/lib/origin.test.ts
git commit -m "feat: add origin parser that builds paths rather than trusting them"
```

---

### Task 2: The rename, by sense

**Files:**
- Modify: `src/app/(app)/wallets/page.tsx`, `WalletList.tsx`, `src/components/WalletForm.tsx`, `src/app/(app)/budgets/BudgetList.tsx`, `src/lib/budget-status.ts`, and every test/e2e pinning a renamed string.

**Do NOT rename:** `src/app/(auth)/**`, `src/app/onboarding/**` — those say "account" meaning a USER account. Renaming them is a bug.

- [ ] **Step 1: Inventory before changing anything**

Run and record the output:
```bash
grep -rn "ccount" src e2e | grep -v "(auth)\|onboarding" | tee /tmp/rename-sites.txt
wc -l /tmp/rename-sites.txt
```

Then read each line and classify it wallet-sense or user-sense. Report any line you cannot classify rather than guessing.

- [ ] **Step 2: Rename the user-visible strings**

| Old | New |
|---|---|
| `Accounts` (page `<h1>`) | `Wallets` |
| `Add account` (button) | `Add wallet` |
| `No accounts yet` | `No wallets yet` |
| `Accounts this budget covers` | `Wallets this budget covers` |
| `All accounts` | `All wallets` |
| `${count} accounts` | `${count} wallets` |
| `Remove budget for X · All accounts` | follows from the scope label |
| `Covers an archived account, so its amount can't be edited here.` | `…archived wallet…` |
| `Accounts in JPY aren't covered by any budget here.` | `Wallets in JPY…` |
| `Doesn't cover X` | unchanged (no noun) |
| `Choose at least one account` | `Choose at least one wallet` |
| `You do not have access to that account.` | `…that wallet.` |
| `Account not found.` | `Wallet not found.` |

- [ ] **Step 3: Update every pinned test and e2e selector in step**

`BudgetList.test.tsx`, `BudgetSummary.test.tsx`, `budgets/page.test.tsx`, `budget-status.test.ts`, `budgets.test.ts`, `e2e/budgets.spec.ts`, `e2e/ledger.spec.ts`.

- [ ] **Step 4: Verify nothing user-sense was renamed**

```bash
grep -rn "wallet" src/app/\(auth\) src/app/onboarding
```
Expected: no user-facing copy changed there. Report what you see.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint && npx playwright test
git add -A src e2e
git commit -m "refactor: rename wallet-sense 'account' to 'wallet' in user-facing copy"
```

---

### Task 3: The wallet detail route

**Files:**
- Create: `src/app/(app)/wallets/[id]/page.tsx`, `src/app/(app)/wallets/[id]/page.test.tsx`
- Modify: `src/app/(app)/wallets/WalletList.tsx` (name becomes a link)

**Interfaces:**
- Consumes: the existing transaction list component used by `/transactions`
- Produces: route `/wallets/<uuid>`

- [ ] **Step 1: Write the failing test**

Cover: the page renders the wallet's name and balance; it renders THAT wallet's transactions and not another's; an id the caller cannot see renders a not-found state rather than throwing or leaking; an archived wallet renders with its archived status stated in text.

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement**

Read `src/app/(app)/transactions/page.tsx` first and reuse its list rather than rebuilding one. Scope the query by `wallet_id`; let RLS do the membership work — do NOT add a second membership check alongside it.

`params` is a Promise in this Next version — check `node_modules/next/dist/docs/` before writing the signature.

- [ ] **Step 4: Make the wallet name a link in `WalletList.tsx`**

Keep Members and Archive on the card. The link's accessible name is the wallet's name.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint && npx playwright test e2e/ledger.spec.ts
git add "src/app/(app)/wallets"
git commit -m "feat: add a wallet detail screen listing that wallet's transactions"
```

---

### Task 4: The add-transaction affordance and the return trip

**Files:**
- Create: `src/app/(app)/wallets/[id]/WalletFab.tsx`
- Modify: `src/app/(app)/transactions/new/page.tsx`, `src/components/TransactionForm.tsx`, and their tests

- [ ] **Step 1: Write the failing tests**

Cover:
- `/transactions/new?wallet=<id>` preselects that wallet;
- a `wallet` param naming a wallet the caller cannot see is IGNORED, falling back to the default selection — never trusted;
- after a successful save with `?from=wallet:<id>`, the form navigates to `/wallets/<id>`;
- with no `from`, it navigates to `/transactions` exactly as before;
- **with `from=https://evil.example` it navigates to `/transactions`** — assert the destination, not merely that a save happened.

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

`TransactionForm` currently does `router.push("/transactions")`. Replace that with `router.push(parseOrigin(from))`, where `from` is a prop threaded from the page's search params. Import `parseOrigin` from `@/lib/origin` — do NOT re-implement the parsing inline, and do not pass a path through the query string.

The FAB links to `/transactions/new?wallet=<id>&from=wallet:<id>`.

- [ ] **Step 4: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add -A src
git commit -m "feat: add a per-wallet add-transaction button that returns you to the wallet"
```

---

### Task 5: Select all / clear all in the budget wallet picker

**Files:**
- Modify: `src/app/(app)/budgets/BudgetList.tsx`, `BudgetList.test.tsx`

- [ ] **Step 1: Write the failing tests**

Four states: pressing it with some unchecked selects all; pressing it with all checked clears all; the label reads `Select all` when any is unchecked and `Clear all` when all are; unchecking one flips the label back.

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

A link-styled `<button type="button">` beside the fieldset legend, in `AddBudgetForm` only — existing budget rows have no wallet picker, because `set_budget` never mutates an existing set.

- [ ] **Step 4: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add "src/app/(app)/budgets"
git commit -m "feat: add select-all to the budget wallet picker"
```

---

### Task 6: End-to-end proof

**Files:**
- Modify: `e2e/ledger.spec.ts` (or a new `e2e/wallet-detail.spec.ts`, whichever fits the file's conventions)

- [ ] **Step 1: Write the spec**

1. Sign up, record an expense.
2. Go to `/wallets`, click the wallet's name, land on `/wallets/<id>`.
3. Assert its transactions render, and that a second wallet's do NOT.
4. Press the plus, record an expense, and assert the URL is `/wallets/<id>` — **not** `/transactions`.
5. `expectNoViolations` while the page is populated.

- [ ] **Step 2: Watch step 4 fail**

Temporarily revert `TransactionForm`'s redirect to the hardcoded `router.push("/transactions")`, re-run, confirm the URL assertion fails, restore, re-run green. Report the exact output.

This is the load-bearing assertion: a test that only checks the transaction saved would pass with the redirect broken.

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npm run lint && npm test && npx playwright test
git add e2e
git commit -m "test(e2e): prove a wallet's add-transaction returns to that wallet"
```

---

## Self-Review

**Spec coverage.** §1 rename → Task 2; §2 detail route → Task 3; §3 FAB → Task 4; §4 the redirect → Tasks 1 and 4, split so the security boundary is its own reviewable unit; §5 select-all → Task 5; §6 testing → distributed, with the open-redirect cases in Task 1 and the destination assertion in Task 6; §7 out of scope → nothing here edits a wallet's name, balance or currency.

**Placeholders.** Tasks 3, 5 and 6 specify assertions rather than full JSX because the markup depends on existing components those tasks must read first. Every value they must hit is pinned.

**Type consistency.** `parseOrigin`'s signature is identical in Tasks 1 and 4. The `from` param name matches between the FAB's link, the page's search params, and the form's prop.
