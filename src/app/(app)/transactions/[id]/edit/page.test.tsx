// src/app/(app)/transactions/[id]/edit/page.test.tsx
//
// Task 6 (editable-transactions plan): the edit-transaction route. Mock
// structure and 404-collapse tests mirror src/app/(app)/wallets/[id]/
// page.test.tsx's own precedent — `@/lib/supabase/server` is mocked before
// this page module loads (the real `createClient` reaches `next/headers`,
// which throws outside a request scope, and `npm test` runs with no
// `.env.local`), and the mock's table handlers simulate RLS by simple
// absence: an id with no entry in the relevant map resolves to zero
// rows/no error — exactly what `transactions_member`/`wallets_select`
// (`is_wallet_member`) produce both for a row that genuinely doesn't exist
// and one that exists but isn't visible to the caller. The page must not be
// able to tell those apart, and this mock deliberately can't either.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

// TransactionForm calls `useRouter()` unconditionally (its post-save
// redirect) — outside a real Next router this throws "invariant expected
// app router to be mounted", the same reason
// src/components/TransactionForm.test.tsx and
// src/app/(app)/transactions/new/page.test.tsx mock this module.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// TransactionForm mounts CategoryPicker, which independently imports
// `@/server/actions/categories` (a "use server" module) to inline-create a
// category — mocked for the same reason TransactionForm.test.tsx mocks it.
vi.mock("@/server/actions/categories", () => ({
  createCategory: vi.fn(),
}));

// `vi.mock` factories are hoisted above this file's own top-level `const`s
// (same reason `/wallets/[id]/page.test.tsx` wraps its fixtures in
// `vi.hoisted`), so every fixture map has to live in here too.
const { txnById, legsByTransferId, walletsById, categoriesByWalletId, categoryById, UUID_RE } = vi.hoisted(
  () => ({
    txnById: new Map<string, Record<string, unknown>>(),
    legsByTransferId: new Map<string, Record<string, unknown>[]>(),
    walletsById: new Map<string, Record<string, unknown>>(),
    categoriesByWalletId: new Map<string, Record<string, unknown>[]>(),
    categoryById: new Map<string, Record<string, unknown>>(),
    // Deliberately loose, matching `/wallets/[id]/page.test.tsx`'s own
    // comment on its identical constant: only needs to tell this file's own
    // fixture ids apart from "not-a-uuid", not to duplicate Postgres's own
    // grammar.
    UUID_RE: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  }),
);

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table === "transactions") {
        let mode: "byId" | "byTransferId" | null = null;
        let key: string | undefined;
        const builder = {
          select: () => builder,
          eq: (col: string, v: string) => {
            if (col === "id") {
              mode = "byId";
              key = v;
            }
            if (col === "transfer_id") {
              mode = "byTransferId";
              key = v;
            }
            return builder;
          },
          is: () => builder,
          maybeSingle: () => builder,
          then: (
            resolve: (v: { data: unknown; error: { code: string; message: string } | null }) => void,
          ) => {
            if (mode === "byId") {
              // Same distinction `/wallets/[id]/page.test.tsx`'s own mock
              // draws (review round 1, I1 there): a real Postgres `uuid`
              // column errors on a non-UUID literal, a different outcome
              // from "zero rows, no error" — collapsing both here would
              // make the malformed-id test unable to tell the page's own
              // `z.uuid()` guard apart from no guard at all.
              if (key && !UUID_RE.test(key)) {
                resolve({
                  data: null,
                  error: { code: "22P02", message: "invalid input syntax for type uuid" },
                });
                return;
              }
              resolve({ data: (key && txnById.get(key)) ?? null, error: null });
              return;
            }
            if (mode === "byTransferId") {
              resolve({ data: (key && legsByTransferId.get(key)) ?? [], error: null });
              return;
            }
            resolve({ data: null, error: null });
          },
        };
        return builder;
      }
      if (table === "wallets") {
        let ids: string[] = [];
        let single = false;
        const builder = {
          select: () => builder,
          eq: (col: string, v: string) => {
            if (col === "id") ids = [v];
            return builder;
          },
          in: (col: string, v: string[]) => {
            if (col === "id") ids = v;
            return builder;
          },
          maybeSingle: () => {
            single = true;
            return builder;
          },
          then: (resolve: (v: { data: unknown; error: null }) => void) => {
            const rows = ids.map((id) => walletsById.get(id)).filter(Boolean);
            resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
          },
        };
        return builder;
      }
      if (table === "categories") {
        let walletId: string | undefined;
        let categoryId: string | undefined;
        let activeOnly = false;
        let single = false;
        const builder = {
          select: () => builder,
          eq: (col: string, v: string) => {
            if (col === "wallet_id") walletId = v;
            if (col === "id") categoryId = v;
            return builder;
          },
          is: (col: string) => {
            if (col === "archived_at") activeOnly = true;
            return builder;
          },
          maybeSingle: () => {
            single = true;
            return builder;
          },
          then: (resolve: (v: { data: unknown; error: null }) => void) => {
            if (single) {
              resolve({ data: (categoryId && categoryById.get(categoryId)) ?? null, error: null });
              return;
            }
            const rows: Record<string, unknown>[] = walletId
              ? (categoriesByWalletId.get(walletId) ?? [])
              : [];
            resolve({
              data: activeOnly ? rows.filter((r) => !r.archived_at) : rows,
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

import EditTransactionPage from "./page";

const TXN_A = "11111111-1111-4111-8111-111111111111";
const TXN_B = "22222222-2222-4222-8222-222222222222";
const WALLET_A = "33333333-3333-4333-8333-333333333333";
const WALLET_B = "44444444-4444-4444-8444-444444444444";
const CATEGORY_A = "55555555-5555-4555-8555-555555555555";
const TRANSFER_A = "66666666-6666-4666-8666-666666666666";

function txn(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "expense",
    wallet_id: WALLET_A,
    amount_minor: -1250,
    currency_code: "USD",
    category_id: CATEGORY_A,
    occurred_on: "2026-08-01",
    note: "weekly shop",
    merchant: "Tesco",
    transfer_id: null,
    ...over,
  };
}

function wallet(id: string, over: Record<string, unknown> = {}) {
  return { id, name: "Everyday", currency_code: "USD", ...over };
}

function category(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: "Groceries",
    kind: "expense",
    color_slot: 1,
    icon: "circle",
    wallet_id: WALLET_A,
    archived_at: null,
    ...over,
  };
}

beforeEach(() => {
  txnById.clear();
  legsByTransferId.clear();
  walletsById.clear();
  categoriesByWalletId.clear();
  categoryById.clear();
});

describe("EditTransactionPage — 404 collapse", () => {
  /**
   * Same shape `/wallets/[id]/page.test.tsx`'s own round-1 fix (M1) pins:
   * both branches rendered in the SAME test and compared byte-for-byte, not
   * two separate tests each using a different loose matcher — so a change
   * that leaked a distinguishing detail onto only ONE branch would still
   * fail here. `TXN_B` is UUID-shaped but produces the RLS "zero rows, no
   * error" result (never added to `txnById` — the same shape a real,
   * invisible, or soft-deleted transaction produces); `"not-a-uuid"` never
   * reaches the database at all (the page's own `z.uuid()` guard
   * short-circuits it first).
   */
  it("renders byte-identical not-found markup for an invisible transaction and a malformed id", async () => {
    const invisibleUi = await EditTransactionPage({ params: Promise.resolve({ id: TXN_B }) });
    const invisible = render(invisibleUi);
    const invisibleHtml = invisible.container.innerHTML;
    invisible.unmount();

    const malformedUi = await EditTransactionPage({ params: Promise.resolve({ id: "not-a-uuid" }) });
    const malformed = render(malformedUi);
    const malformedHtml = malformed.container.innerHTML;
    malformed.unmount();

    expect(invisibleHtml).toBe(malformedHtml);
    expect(invisibleHtml).toContain("Transaction not found");
  });

  it("renders not-found when a transfer's other leg isn't visible (partial membership)", async () => {
    txnById.set(TXN_A, txn(TXN_A, { kind: "transfer", transfer_id: TRANSFER_A, category_id: null }));
    // Only ONE leg present — the same "incomplete pair" shape
    // `updateTransfer`'s own pre-flight lookup refuses, simulating a caller
    // who has since lost membership on the other wallet.
    legsByTransferId.set(TRANSFER_A, [
      { wallet_id: WALLET_A, amount_minor: -1250, currency_code: "USD", occurred_on: "2026-08-01", note: null, merchant: null },
    ]);

    const ui = await EditTransactionPage({ params: Promise.resolve({ id: TXN_A }) });
    render(ui);

    expect(screen.getByText("Transaction not found")).toBeInTheDocument();
  });
});

describe("EditTransactionPage — seeds an expense/income transaction", () => {
  it("renders the edit form seeded from the loaded row", async () => {
    txnById.set(TXN_A, txn(TXN_A));
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Everyday" }));
    categoriesByWalletId.set(WALLET_A, [category(CATEGORY_A, { name: "Groceries" })]);

    const ui = await EditTransactionPage({ params: Promise.resolve({ id: TXN_A }) });
    render(ui);

    expect(screen.getByRole("status", { name: "Amount" }).textContent).toContain("12.50");
    expect(screen.getByDisplayValue("2026-08-01")).toBeInTheDocument();
    expect(screen.getByDisplayValue("weekly shop")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Tesco")).toBeInTheDocument();
    expect(screen.getByText("Everyday")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Groceries" })).toHaveAttribute("aria-pressed", "true");
    // No wallet/kind control — see TransactionForm.test.tsx for the full
    // contract; this just confirms the page actually wired `mode="edit"`.
    expect(screen.queryByRole("combobox", { name: /Wallet/i })).not.toBeInTheDocument();
  });

  it("still shows and preselects the transaction's category even if it has since been archived", async () => {
    txnById.set(TXN_A, txn(TXN_A, { category_id: CATEGORY_A }));
    walletsById.set(WALLET_A, wallet(WALLET_A));
    // The wallet's ACTIVE category list does not include it...
    categoriesByWalletId.set(WALLET_A, []);
    // ...but the row's own category is still fetchable directly.
    categoryById.set(CATEGORY_A, category(CATEGORY_A, { name: "Old Category", archived_at: "2026-01-01T00:00:00Z" }));

    const ui = await EditTransactionPage({ params: Promise.resolve({ id: TXN_A }) });
    render(ui);

    expect(screen.getByRole("button", { name: "Old Category" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("EditTransactionPage — seeds a transfer", () => {
  /**
   * Fix round 1, IMPORTANT 2. This test's previous fixture could not fail:
   * both legs were `-5000`/`+5000` in ONE currency across two same-currency
   * wallets, so `amountOut` and `amountIn` came out identical, and the
   * assertions only checked that both wallet names appeared SOMEWHERE — never
   * in which role. The reviewer swapped page.tsx's `l.amount_minor < 0` and
   * `> 0` and all 18 tests still passed.
   *
   * The legs are now distinguishable on all three axes at once — different
   * wallets, different currencies (USD out / JPY in), different magnitudes
   * (5000 minor / 920000 minor) — and the assertions below read the
   * DIRECTION rather than mere presence:
   *
   * - the FROM wallet is the negative leg's wallet and the TO wallet is the
   *   positive leg's, asserted as one ordered string so a swap cannot satisfy
   *   it by having both names on screen;
   * - the seeded outgoing amount is the negative leg's magnitude rendered in
   *   the negative leg's own currency (`$50.00`, not `¥920,000`), read out of
   *   the "You send" group specifically rather than whichever keypad the DOM
   *   happens to yield first.
   *
   * The production change that breaks it: swapping those two comparisons in
   * page.tsx. Under the swap the direction line reads "From Holiday to
   * Everyday" and the send group is labelled `(JPY)` holding `¥920,000` —
   * three independent failures, verified by mutation (see this round's
   * report).
   *
   * The old "same-currency legs -> one amount field" assertion is deliberately
   * not kept here: `TransactionForm.test.tsx` owns the one-vs-two-keypad
   * contract off its own seeds, and asserting TWO fields here is the stronger
   * page-level claim anyway — it proves the page passed each wallet's real
   * currency through, which a same-currency fixture cannot show.
   */
  it("seeds the FROM side from the negative leg and the TO side from the positive leg", async () => {
    txnById.set(
      TXN_A,
      txn(TXN_A, { kind: "transfer", transfer_id: TRANSFER_A, category_id: null, wallet_id: WALLET_A }),
    );
    legsByTransferId.set(TRANSFER_A, [
      // Deliberately listed POSITIVE-first, so array order and sign order
      // disagree: a `legs[0]`/`legs[1]` implementation would also fail here,
      // not just a swapped sign comparison.
      {
        wallet_id: WALLET_B,
        amount_minor: 920000,
        currency_code: "JPY",
        occurred_on: "2026-08-02",
        note: "",
        merchant: "",
      },
      {
        wallet_id: WALLET_A,
        amount_minor: -5000,
        currency_code: "USD",
        occurred_on: "2026-08-02",
        note: "",
        merchant: "",
      },
    ]);
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Everyday", currency_code: "USD" }));
    walletsById.set(WALLET_B, wallet(WALLET_B, { name: "Holiday", currency_code: "JPY" }));

    const ui = await EditTransactionPage({ params: Promise.resolve({ id: TXN_A }) });
    render(ui);

    // TransactionForm states a transfer's fixed wallets as text:
    // `From <name> to <name>`. Read as one ordered string — "both names are
    // on screen" is exactly the assertion that let the swap through.
    expect(screen.getByText("Everyday").parentElement).toHaveTextContent(
      "From Everyday to Holiday",
    );

    // The outgoing keypad is identified by its own group label ("You send
    // (USD)"), not by DOM order — both keypads' <output>s are named
    // "Amount". Its preview is formatMoney(5000, "USD"): the NEGATIVE leg's
    // magnitude, in the NEGATIVE leg's currency.
    const sendGroup = screen.getByRole("group", { name: "You send (USD)" });
    expect(within(sendGroup).getByRole("status", { name: "Amount" })).toHaveTextContent("$50.00");

    // ...and the incoming keypad carries the positive leg's own magnitude and
    // currency, so neither amount can be silently sourced from the other leg.
    const receiveGroup = screen.getByRole("group", { name: "They receive (JPY)" });
    expect(within(receiveGroup).getByRole("status", { name: "Amount" })).toHaveTextContent("¥920,000");

    expect(screen.getByText(/both legs/i)).toBeInTheDocument();
    expect(screen.getAllByLabelText("Amount")).toHaveLength(2);
    // No category control on a transfer.
    expect(screen.queryByLabelText("Search categories")).not.toBeInTheDocument();
  });
});
