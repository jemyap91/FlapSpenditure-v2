// src/app/(app)/page.test.tsx
//
// Fix round 1 (task-6, I8): spec §7 ("Due/handled computation... a deleted
// transaction returning its occurrence to due") lists this as required
// coverage. `due-rows.test.ts` already proves `buildDueRows` treats a
// handled date as still-due once it's no longer in the `recorded` set it's
// handed — but nothing proved page.tsx's OWN query (`.is("deleted_at",
// null)`) actually keeps a soft-deleted transaction's occurrence out of that
// set in the first place. Three sibling routes (budgets/page.test.tsx,
// transactions/new/page.test.tsx, wallets/[id]/page.test.tsx) already carry
// a page.test.tsx, so this is local convention, not a new pattern.
//
// `@/lib/supabase/server` is mocked before this page module loads —
// budgets/page.test.tsx's own precedent: the real `createClient` reaches
// `next/headers`, which throws outside a request scope, and `npm test` runs
// with no `.env.local` in any case.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

// `DueList` (rendered by this page) imports `shortDate` from
// `RecurringList.tsx`, which imports `archiveRule` from
// `@/server/actions/recurring` and, via `RecurringForm`, `createCategory`
// from `@/server/actions/categories` — both "use server" modules that
// import `@/lib/supabase/server`, which throws at import time outside a
// configured environment. Same mocks, same reasoning, as
// DueList.test.tsx's own.
vi.mock("@/server/actions/recurring", () => ({
  recordOccurrence: vi.fn(),
  skipOccurrence: vi.fn(),
}));
vi.mock("@/server/actions/categories", () => ({
  createCategory: vi.fn(),
}));

const { walletsData, rulesData, skipsData, transactionsData } = vi.hoisted(() => ({
  walletsData: [] as { id: string; currency_code: string; created_at: string }[],
  rulesData: [] as Record<string, unknown>[],
  skipsData: [] as { rule_id: string; occurrence_on: string }[],
  transactionsData: [] as { recurring_id: string | null; occurred_on: string; deleted_at: string | null }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string) => {
      // Every RPC this page calls (`get_category_breakdown`,
      // `get_cash_flow`, `get_budget_status`) is irrelevant to the due-list
      // question this file tests — a quiet, error-free empty result for all
      // three keeps the rest of the page's own "error is not emptiness"
      // checks satisfied without asserting anything about them here.
      if (["get_category_breakdown", "get_cash_flow", "get_budget_status"].includes(name)) {
        return { data: [], error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    from: (table: string) => {
      if (table === "wallets") {
        const builder = {
          select: () => builder,
          is: () => builder,
          order: () => builder,
          then: (resolve: (v: { data: typeof walletsData; error: null }) => void) =>
            resolve({ data: walletsData, error: null }),
        };
        return builder;
      }
      if (table === "recurring_rules") {
        const builder = {
          select: () => builder,
          order: () => builder,
          then: (resolve: (v: { data: typeof rulesData; error: null }) => void) =>
            resolve({ data: rulesData, error: null }),
        };
        return builder;
      }
      if (table === "recurring_skips") {
        const builder = {
          select: () => builder,
          gte: () => builder,
          then: (resolve: (v: { data: typeof skipsData; error: null }) => void) =>
            resolve({ data: skipsData, error: null }),
        };
        return builder;
      }
      if (table === "transactions") {
        // Applies its filters FOR REAL against `transactionsData`, rather
        // than ignoring them like the simpler tables above — this table's
        // `deleted_at is null` filter is the exact behaviour this test
        // exists to prove page.tsx's own query preserves, not just
        // `buildDueRows`'s (already covered in due-rows.test.ts).
        let excludeNullRecurringId = false;
        let requireDeletedAtNull = false;
        let occurredOnGte: string | undefined;
        const builder = {
          select: () => builder,
          not: (col: string, op: string, val: unknown) => {
            if (col === "recurring_id" && op === "is" && val === null) excludeNullRecurringId = true;
            return builder;
          },
          is: (col: string, val: unknown) => {
            if (col === "deleted_at" && val === null) requireDeletedAtNull = true;
            return builder;
          },
          gte: (col: string, val: string) => {
            if (col === "occurred_on") occurredOnGte = val;
            return builder;
          },
          then: (resolve: (v: { data: { recurring_id: string; occurred_on: string }[]; error: null }) => void) => {
            let rows = transactionsData;
            if (excludeNullRecurringId) rows = rows.filter((r) => r.recurring_id !== null);
            if (requireDeletedAtNull) rows = rows.filter((r) => r.deleted_at === null);
            if (occurredOnGte) rows = rows.filter((r) => r.occurred_on >= occurredOnGte!);
            resolve({
              data: rows.map((r) => ({ recurring_id: r.recurring_id!, occurred_on: r.occurred_on })),
              error: null,
            });
          },
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import DashboardPage from "./page";

const WALLET_ID = "11111111-1111-4111-8111-111111111111";
const RULE_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  walletsData.length = 0;
  rulesData.length = 0;
  skipsData.length = 0;
  transactionsData.length = 0;

  walletsData.push({ id: WALLET_ID, currency_code: "SGD", created_at: "2026-01-01T00:00:00Z" });
  rulesData.push({
    id: RULE_ID,
    name: "Rent",
    kind: "expense",
    amount_minor: -150000,
    currency_code: "SGD",
    interval_unit: "monthly",
    anchor_on: "2026-09-01",
    ends_on: null,
    archived_at: null,
    wallets: { name: "Everyday", currency_code: "SGD", archived_at: null },
    categories: { kind: "expense", archived_at: null },
  });

  // Pins `todayLocalDate()` to a known calendar date — same reasoning and
  // same construction (LOCAL components, read back via LOCAL getters) as
  // `recurring.test.ts`'s identical `beforeEach`: both sides of the round
  // trip run in whatever timezone the test machine is in, so they always
  // agree regardless of what that timezone actually is.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 1, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DashboardPage — due list (I8: a deleted transaction returns its occurrence to due)", () => {
  it("still offers Record for an occurrence whose only transaction was soft-deleted", async () => {
    // A transaction WAS recorded for 1 September's rent, then deleted
    // (TransactionList's own undo-based deletion) — `deleted_at` is set,
    // not null. The occurrence must come back to due, not stay hidden
    // behind a transaction that no longer counts.
    transactionsData.push({ recurring_id: RULE_ID, occurred_on: "2026-09-01", deleted_at: "2026-08-20T00:00:00Z" });

    const ui = await DashboardPage();
    render(ui);

    expect(screen.getByRole("button", { name: "Record Rent for 1 Sep" })).toBeInTheDocument();
  });
});
