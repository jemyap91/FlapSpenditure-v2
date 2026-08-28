// src/app/(app)/transactions/new/page.test.tsx
//
// Task 4 (wallet-detail plan): `/transactions/new` gains two optional
// search params — `wallet` (preselect) and `from` (return destination,
// threaded straight through to TransactionForm and covered by that
// component's own test, TransactionForm.test.tsx). This file covers the
// `wallet` param's "preselects but does not authorise" contract: it must
// only ever resolve to a wallet already present in the page's own
// (RLS-scoped) `wallets` query, falling back to the existing default (the
// first wallet) for anything else — an id naming a wallet the caller
// cannot see, a well-formed but nonexistent uuid, or a non-uuid string —
// with no distinguishable error for any of those.
//
// `@/lib/supabase/server` is mocked before this page module loads — the
// real `createClient` reaches `next/headers`, which throws outside a
// request scope, and `npm test` runs with no `.env.local` — same precedent
// as src/app/(app)/budgets/page.test.tsx and
// src/app/(app)/wallets/[id]/page.test.tsx.
//
// `next/navigation` is mocked because TransactionForm (rendered by this
// page) calls `useRouter()` — outside a real Next router this throws
// "invariant expected app router to be mounted", the same reason
// src/app/(app)/wallets/[id]/page.test.tsx mocks this module.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { walletsData, categoriesData } = vi.hoisted(() => ({
  walletsData: [] as { id: string; name: string; currency_code: string }[],
  categoriesData: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
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
      if (table === "categories") {
        const builder = {
          select: () => builder,
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

import NewTransactionPage from "./page";

const WALLET_A = "11111111-1111-4111-8111-111111111111";
const WALLET_B = "22222222-2222-4222-8222-222222222222";
const NOT_MINE = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  walletsData.length = 0;
  categoriesData.length = 0;
  walletsData.push(
    { id: WALLET_A, name: "Everyday", currency_code: "USD" },
    { id: WALLET_B, name: "Savings", currency_code: "USD" },
  );
});

describe("NewTransactionPage — ?wallet preselects, but only from the caller's own list", () => {
  it("preselects the wallet named by ?wallet", async () => {
    const ui = await NewTransactionPage({
      searchParams: Promise.resolve({ wallet: WALLET_B }),
    });
    render(ui);

    expect(screen.getByRole("combobox", { name: "Wallet" })).toHaveValue(WALLET_B);
  });

  it("falls back to the default wallet when ?wallet names one the caller cannot see, rather than erroring", async () => {
    const ui = await NewTransactionPage({
      searchParams: Promise.resolve({ wallet: NOT_MINE }),
    });
    render(ui);

    // Silently falls back to the first wallet in the caller's own
    // RLS-scoped list — never a distinguishable error, and never the
    // supplied (invisible) wallet.
    expect(screen.getByRole("combobox", { name: "Wallet" })).toHaveValue(WALLET_A);
  });

  it("falls back to the default wallet when ?wallet is not a uuid at all", async () => {
    const ui = await NewTransactionPage({
      searchParams: Promise.resolve({ wallet: "not-a-uuid" }),
    });
    render(ui);

    expect(screen.getByRole("combobox", { name: "Wallet" })).toHaveValue(WALLET_A);
  });

  it("defaults to the first wallet when ?wallet is absent", async () => {
    const ui = await NewTransactionPage({ searchParams: Promise.resolve({}) });
    render(ui);

    expect(screen.getByRole("combobox", { name: "Wallet" })).toHaveValue(WALLET_A);
  });
});
