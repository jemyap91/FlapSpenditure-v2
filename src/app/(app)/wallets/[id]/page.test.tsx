// src/app/(app)/wallets/[id]/page.test.tsx
//
// Task 3 (wallet detail screen): the four cases the brief pins, plus one
// adversarial case in the same "does not leak, does not throw" family —
// this project's recent tasks (see .superpowers/sdd/2026-08-27-wallet-detail/
// progress.md, Task 1) have consistently found that an untested adjacent
// input is where a guard turns out not to guard anything.
//
// `@/lib/supabase/server` is mocked before this page module loads, following
// src/app/(app)/budgets/page.test.tsx's own precedent: the real
// `createClient` reaches `next/headers`, which throws outside a request
// scope, and `npm test` runs with no `.env.local` in any case.
//
// The mock's `wallets` table handler simulates RLS by simple absence: a
// wallet id with no entry in `walletsById` resolves to zero rows/no error —
// exactly what `wallets_select` (`is_wallet_member`) produces for a wallet
// that exists but isn't visible to the caller, and what a nonexistent id
// produces too. The page must not be able to tell the two apart, and this
// mock deliberately can't either.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// `TransactionList` (reused here — see page.tsx's own doc comment) calls
// `useRouter()` for its error-branch `.refresh()` — see that component's
// doc comment. Outside a real Next router this throws "invariant expected
// app router to be mounted", exactly the same reason
// src/components/TransactionList.test.tsx mocks this module.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { walletsById, transactionsData, balancesData, membersData } = vi.hoisted(() => ({
  walletsById: new Map<string, Record<string, unknown>>(),
  transactionsData: [] as Record<string, unknown>[],
  balancesData: [] as { wallet_id: string; balance_minor: number; currency_code: string }[],
  membersData: [] as { wallet_id: string; user_id: string; display_name: string }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string) => {
      if (name === "get_wallet_balances") return { data: balancesData, error: null };
      if (name === "get_wallet_members") return { data: membersData, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
    from: (table: string) => {
      if (table === "wallets") {
        let eqId: string | undefined;
        const builder = {
          select: () => builder,
          eq: (col: string, val: string) => {
            if (col === "id") eqId = val;
            return builder;
          },
          maybeSingle: () => builder,
          then: (resolve: (v: { data: unknown; error: null }) => void) =>
            resolve({ data: (eqId && walletsById.get(eqId)) ?? null, error: null }),
        };
        return builder;
      }
      if (table === "transactions") {
        let eqWalletId: string | undefined;
        const builder = {
          select: () => builder,
          eq: (col: string, val: string) => {
            if (col === "wallet_id") eqWalletId = val;
            return builder;
          },
          is: () => builder,
          order: () => builder,
          limit: () => builder,
          then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
            resolve({
              data: transactionsData.filter((r) => r.wallet_id === eqWalletId),
              error: null,
            }),
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import WalletDetailPage from "./page";

const WALLET_A = "11111111-1111-4111-8111-111111111111";
const WALLET_B = "22222222-2222-4222-8222-222222222222";

function wallet(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: "Everyday",
    kind: "bank",
    currency_code: "USD",
    color_slot: 1,
    icon: "landmark",
    owner_id: "u1",
    archived_at: null,
    ...over,
  };
}

function txn(id: string, walletId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "expense",
    amount_minor: -500,
    currency_code: "USD",
    occurred_on: "2026-08-18",
    note: null,
    created_by: null,
    wallet_id: walletId,
    categories: null,
    ...over,
  };
}

beforeEach(() => {
  walletsById.clear();
  transactionsData.length = 0;
  balancesData.length = 0;
  membersData.length = 0;
});

describe("WalletDetailPage", () => {
  it("renders the wallet's name and balance", async () => {
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Everyday" }));
    balancesData.push({ wallet_id: WALLET_A, balance_minor: 125000, currency_code: "USD" });

    const ui = await WalletDetailPage({ params: Promise.resolve({ id: WALLET_A }) });
    render(ui);

    expect(screen.getByRole("heading", { level: 1, name: "Everyday" })).toBeInTheDocument();
    expect(screen.getByText("$1,250.00")).toBeInTheDocument();
  });

  it("renders that wallet's transactions and not another wallet's", async () => {
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Everyday" }));
    transactionsData.push(
      txn("t1", WALLET_A, { note: "Coffee" }),
      txn("t2", WALLET_B, { note: "Someone else's groceries" }),
    );

    const ui = await WalletDetailPage({ params: Promise.resolve({ id: WALLET_A }) });
    render(ui);

    expect(screen.getByText("Coffee")).toBeInTheDocument();
    expect(screen.queryByText("Someone else's groceries")).not.toBeInTheDocument();
    // The controller addendum pins this exact accessible name for the
    // transaction list region — asserted directly here rather than only
    // relying on TransactionList's own (differently-named) default.
    expect(screen.getByRole("region", { name: "Transactions in Everyday" })).toBeInTheDocument();
  });

  it("states the pinned empty-state copy when this wallet has no transactions", async () => {
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Everyday" }));
    // transactionsData stays empty.

    const ui = await WalletDetailPage({ params: Promise.resolve({ id: WALLET_A }) });
    render(ui);

    expect(screen.getByText("No transactions in this wallet yet.")).toBeInTheDocument();
  });

  it("renders a not-found state, not a throw, for an id the caller cannot see", async () => {
    // WALLET_B is never added to walletsById — same zero-rows/no-error shape
    // RLS produces both for "does not exist" and "exists but not yours". The
    // page must not distinguish them.
    const ui = await WalletDetailPage({ params: Promise.resolve({ id: WALLET_B }) });
    render(ui);

    // Not the multi-wallet /wallets screen's "Wallets" heading, and not this
    // wallet's own name (it has none to show) — the SAME not-found copy a
    // nonexistent id produces, asserted by the malformed-id case below.
    expect(screen.getByRole("heading", { level: 1, name: /not found/i })).toBeInTheDocument();
  });

  it("renders an archived wallet with its archived status stated in text", async () => {
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Old Wallet", archived_at: "2026-01-01T00:00:00Z" }));

    const ui = await WalletDetailPage({ params: Promise.resolve({ id: WALLET_A }) });
    render(ui);

    expect(screen.getByText("This wallet is archived.")).toBeInTheDocument();
  });

  it("renders a not-found state, not a thrown/leaked DB error, for a malformed id", async () => {
    const ui = await WalletDetailPage({ params: Promise.resolve({ id: "not-a-uuid" }) });
    render(ui);

    expect(screen.getByText(/wallet.*not found/i)).toBeInTheDocument();
  });
});
