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

// `vi.mock` factories are hoisted above this file's own top-level `const`s
// (same reason budgets/page.test.tsx wraps its fixtures in `vi.hoisted` —
// see that file's own doc comment), so `UUID_RE` has to live in here too,
// not as a plain module-level const the factory below closes over.
const { walletsById, transactionsData, balancesData, membersData, UUID_RE } = vi.hoisted(() => ({
  walletsById: new Map<string, Record<string, unknown>>(),
  transactionsData: [] as Record<string, unknown>[],
  balancesData: [] as { wallet_id: string; balance_minor: number; currency_code: string }[],
  membersData: [] as { wallet_id: string; user_id: string; display_name: string }[],
  // Deliberately loose (not `z.uuid()`, not the exact grammar Postgres
  // enforces) — this only needs to distinguish the fixture ids used below
  // ("11111111-...", "not-a-uuid") from each other, not to duplicate the
  // production validator's own logic.
  UUID_RE: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
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
          // Review round 1 (I1): a real Postgres `uuid` column raises
          // `invalid input syntax for type uuid` (confirmed live against
          // this branch's own database) for a non-UUID-shaped literal — a
          // DIFFERENT outcome from "zero rows, no error" (what RLS produces
          // for a real-but-invisible wallet). Before this branch, this mock
          // returned the same shape for both, which meant the malformed-id
          // test below could not tell page.tsx's `z.uuid()` guard apart
          // from having no guard at all — deleting the guard still passed.
          then: (
            resolve: (v: { data: unknown; error: { code: string; message: string } | null }) => void,
          ) => {
            if (eqId && !UUID_RE.test(eqId)) {
              resolve({
                data: null,
                error: { code: "22P02", message: "invalid input syntax for type uuid" },
              });
              return;
            }
            resolve({ data: (eqId && walletsById.get(eqId)) ?? null, error: null });
          },
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

  /**
   * Review round 1 (M1): the prior version of this file had two separate
   * not-found tests, each using a different loose matcher against a
   * different query — which meant a change that leaked "...or is not yours"
   * onto only ONE of the two branches would still pass both. Rendering both
   * branches in the SAME test and asserting the markup is byte-identical
   * pins the anti-leak property itself, not just "each branch says
   * something not-found-shaped."
   *
   * The two inputs are deliberately different in KIND, not just value:
   * `WALLET_B` is UUID-shaped but produces the RLS "zero rows, no error"
   * result (never added to `walletsById` — the same shape a real, invisible
   * wallet produces); `"not-a-uuid"` never reaches the database at all
   * (page.tsx's `z.uuid()` guard short-circuits it). Three different causes
   * — doesn't exist, exists but not mine, not even a UUID — one rendered
   * output.
   */
  it("renders byte-identical not-found markup for an invisible wallet and a malformed id", async () => {
    // WALLET_B is never added to walletsById — same zero-rows/no-error shape
    // RLS produces both for "does not exist" and "exists but not yours".
    const invisibleUi = await WalletDetailPage({ params: Promise.resolve({ id: WALLET_B }) });
    const invisible = render(invisibleUi);
    const invisibleHtml = invisible.container.innerHTML;
    invisible.unmount();

    const malformedUi = await WalletDetailPage({ params: Promise.resolve({ id: "not-a-uuid" }) });
    const malformed = render(malformedUi);
    const malformedHtml = malformed.container.innerHTML;
    malformed.unmount();

    expect(invisibleHtml).toBe(malformedHtml);
    expect(invisibleHtml).toContain("Wallet not found");
  });

  it("renders an archived wallet with its archived status stated in text, and still lists its history", async () => {
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Old Wallet", archived_at: "2026-01-01T00:00:00Z" }));
    // Review round 1 (I2): the addendum's binding rule is "archiving hides
    // a wallet from lists; it does not delete its history" — a change that
    // skipped the transactions query for archived wallets would previously
    // have shipped green here, because this fixture had no transactions to
    // lose.
    transactionsData.push(txn("t1", WALLET_A, { note: "Old purchase" }));

    const ui = await WalletDetailPage({ params: Promise.resolve({ id: WALLET_A }) });
    render(ui);

    expect(
      screen.getByText("This wallet is archived, so new transactions can’t be added to it."),
    ).toBeInTheDocument();
    expect(screen.getByText("Old purchase")).toBeInTheDocument();
  });

  /**
   * Review round 1 (I3): `get_wallet_balances()` filters `archived_at is
   * null` server-side, so an archived wallet's id is simply absent from
   * that RPC's result and `mergeWalletBalances` maps the absence to `null`
   * — the SAME value it uses for "we did not compute this." But an archived
   * wallet's balance is perfectly computable; the RPC just declines to. The
   * em dash `WalletList.tsx` uses for a genuinely-unknown balance would
   * therefore be WRONG here, stating a design decision in the vocabulary of
   * a compute failure. This wallet has no balance row at all (never pushed
   * to `balancesData`), simulating exactly what the RPC returns for any
   * archived wallet.
   */
  it("says why an archived wallet's balance isn't shown, rather than an em dash", async () => {
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Old Wallet", archived_at: "2026-01-01T00:00:00Z" }));

    const ui = await WalletDetailPage({ params: Promise.resolve({ id: WALLET_A }) });
    render(ui);

    expect(screen.getByText("Balance is not shown for archived wallets.")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  /**
   * Task 4 (wallet-detail plan): the floating add-transaction button. The
   * controller addendum pins its accessible name exactly — asserted here,
   * not just "a link exists," since a generic "Add" would be ambiguous
   * against Sidebar/TabBar's own "Add" nav item once axe/screen-reader
   * users are scanning the page for every "Add"-shaped control at once.
   * The href is asserted too: it must carry BOTH `wallet=<id>` (preselect)
   * and `from=wallet:<id>` (return trip) — see WalletFab.tsx's own doc
   * comment for why neither is optional.
   */
  it("offers a FAB that preselects this wallet and returns to it after a save", async () => {
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Everyday" }));

    const ui = await WalletDetailPage({ params: Promise.resolve({ id: WALLET_A }) });
    render(ui);

    const fab = screen.getByRole("link", { name: "Add a transaction to Everyday" });
    expect(fab).toHaveAttribute(
      "href",
      `/transactions/new?wallet=${WALLET_A}&from=wallet:${WALLET_A}`,
    );
  });

  /**
   * An archived wallet is excluded from /transactions/new's own `wallets`
   * query (that page's `.is("archived_at", null)` filter) — so a FAB
   * offered here would preselect nothing (its `wallet` param would fail
   * that page's own membership check and silently fall back to a
   * DIFFERENT wallet, with no error to explain why). Rather than offer an
   * affordance that quietly does the wrong thing, the FAB does not render
   * at all once this wallet is archived.
   */
  it("does not offer the FAB on an archived wallet", async () => {
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Old Wallet", archived_at: "2026-01-01T00:00:00Z" }));

    const ui = await WalletDetailPage({ params: Promise.resolve({ id: WALLET_A }) });
    render(ui);

    // Positive anchor (review round 1, fix 3): proves this actually
    // rendered the archived wallet page rather than passing vacuously
    // because some earlier path threw or fell through to WalletNotFound.
    expect(
      screen.getByText("This wallet is archived, so new transactions can’t be added to it."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Add a transaction/ })).not.toBeInTheDocument();
  });
});
