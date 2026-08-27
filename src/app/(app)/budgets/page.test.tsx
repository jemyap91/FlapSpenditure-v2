// src/app/(app)/budgets/page.test.tsx
//
// B1 (whole-branch review, blocking): /budgets could not save ANYTHING for a
// user whose wallets are not in USD, and the screen gave no clue why. The
// page resolved its "primary currency" as `profile.base_currency` — but
// nothing in this codebase ever writes that column away from its 'USD'
// default (see (app)/page.tsx's own doc comment, which already states this
// and uses the first-created active wallet's currency instead). For an SGD
// user, `profile.base_currency` stays 'USD' forever, so every wallet is
// filtered OUT of `primaryWallets`/`primaryCurrency`, the wallet picker
// renders zero checkboxes, and every submit sends `walletIds: []` — refused
// forever by budgetInput's `.min(1)`, with nothing on screen explaining why.
//
// This is a page-level test, not a BudgetList-level one, because BudgetList
// already does the right thing with whatever `primaryCurrency` it is GIVEN
// (see BudgetList.test.tsx's own SGD-primaryCurrency cases) — the bug is
// entirely in how page.tsx DERIVES that currency before handing it down, so
// only a test that exercises page.tsx's own derivation catches it.
//
// `@/lib/supabase/server` and `@/lib/supabase/current-user` are mocked
// before either module loads, following src/server/actions/budgets.test.ts's
// own precedent for the exact same reason: their real implementations reach
// `next/headers`, which throws outside a request scope.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { getCurrentUserProfile, walletsData, categoriesData } = vi.hoisted(() => ({
  getCurrentUserProfile: vi.fn(),
  walletsData: [] as { id: string; name: string; currency_code: string }[],
  categoriesData: [] as { name: string; wallet_id: string }[],
}));

vi.mock("@/lib/supabase/current-user", () => ({ getCurrentUserProfile }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async () => ({ data: [], error: null }),
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
      if (table === "budget_wallets") {
        const builder = {
          select: () => builder,
          in: () => builder,
          then: (resolve: (v: { data: []; error: null }) => void) => resolve({ data: [], error: null }),
        };
        return builder;
      }
      if (table === "categories") {
        const builder = {
          select: () => builder,
          in: () => builder,
          eq: () => builder,
          is: () => builder,
          order: () => builder,
          then: (resolve: (v: { data: typeof categoriesData; error: null }) => void) =>
            resolve({ data: categoriesData, error: null }),
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import BudgetsPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  walletsData.length = 0;
  categoriesData.length = 0;
  // The real, never-overwritten default (confirmed: no write to
  // `base_currency` anywhere in this codebase outside the profiles table's
  // own DEFAULT) — an SGD user's profile row still reads 'USD' forever.
  getCurrentUserProfile.mockResolvedValue({ id: "u1", theme: "system", base_currency: "USD" });
});

describe("BudgetsPage — primary currency for a non-USD user (B1)", () => {
  it("offers the wallet picker's checkboxes when every active wallet is in a non-USD currency", async () => {
    walletsData.push({ id: "w1", name: "Everyday", currency_code: "SGD" });

    const ui = await BudgetsPage();
    render(ui);

    // The dashboard's own rule ((app)/page.tsx): primary currency is the
    // first-created active wallet's currency, never `profile.base_currency`.
    // An SGD-only user must see her SGD wallet offered, not zero checkboxes.
    expect(screen.getByRole("checkbox", { name: "Everyday" })).toBeInTheDocument();
  });
});
