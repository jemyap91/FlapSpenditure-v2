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
import userEvent from "@testing-library/user-event";

// TransactionForm calls `useRouter()` unconditionally (its post-save
// redirect) — outside a real Next router this throws "invariant expected
// app router to be mounted", the same reason
// src/components/TransactionForm.test.tsx and
// src/app/(app)/transactions/new/page.test.tsx mock this module.
//
// `push` is hoisted and shared (fix round 1, Minor 1) rather than a fresh
// `vi.fn()` per call: the `?from` threading test below has to read the
// argument the form actually pushed, and a per-call mock is unobservable.
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

// The form dispatches a real Server Function on Save. Mocked here for the
// same reason src/components/TransactionForm.test.tsx mocks it — and because
// this file's Supabase mock stands in for the READ path only; it has no
// `auth` at all, so the real action would throw before reaching a redirect.
vi.mock("@/server/actions/transactions", () => ({
  createTransaction: vi.fn(),
  createTransfer: vi.fn(),
  updateTransaction: vi.fn(async () => ({ ok: true })),
  updateTransfer: vi.fn(async () => ({ ok: true })),
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
  // `archived_at` defaults to null (task 8, item 2) so every pre-existing
  // fixture keeps rendering the FORM — the archived cases have to opt in,
  // which is what makes the archived tests below discriminating rather than
  // the ambient state of this file.
  return { id, name: "Everyday", currency_code: "USD", archived_at: null, ...over };
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
  push.mockClear();
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
    const invisibleUi = await EditTransactionPage({ params: Promise.resolve({ id: TXN_B }), searchParams: Promise.resolve({}) });
    const invisible = render(invisibleUi);
    const invisibleHtml = invisible.container.innerHTML;
    invisible.unmount();

    const malformedUi = await EditTransactionPage({ params: Promise.resolve({ id: "not-a-uuid" }), searchParams: Promise.resolve({}) });
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

    const ui = await EditTransactionPage({ params: Promise.resolve({ id: TXN_A }), searchParams: Promise.resolve({}) });
    render(ui);

    expect(screen.getByText("Transaction not found")).toBeInTheDocument();
  });
});

describe("EditTransactionPage — seeds an expense/income transaction", () => {
  it("renders the edit form seeded from the loaded row", async () => {
    txnById.set(TXN_A, txn(TXN_A));
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Everyday" }));
    categoriesByWalletId.set(WALLET_A, [category(CATEGORY_A, { name: "Groceries" })]);

    const ui = await EditTransactionPage({ params: Promise.resolve({ id: TXN_A }), searchParams: Promise.resolve({}) });
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

    const ui = await EditTransactionPage({ params: Promise.resolve({ id: TXN_A }), searchParams: Promise.resolve({}) });
    render(ui);

    expect(screen.getByRole("button", { name: "Old Category" })).toHaveAttribute("aria-pressed", "true");
  });
});

/**
 * Fix round 1, Minor 1. `TransactionForm.test.tsx` owns the redirect contract
 * itself (given a `from` prop, where does it push?); what is only observable
 * HERE is whether this page actually reads `?from` off the query string and
 * hands it to the form at all. Without this, the whole return trip could be
 * wired end to end and never activated, and every test would still pass.
 *
 * The repeated-param case is the fixture on purpose: `?from=a&from=b`
 * delivers a `string[]` at runtime, and an unnormalised array reaching
 * `parseOrigin` threw `from.split is not a function` INSIDE the post-save
 * transition — after the save had already succeeded — which is the gotcha
 * `/transactions/new/page.tsx` writes up and this page was told to follow
 * exactly. Asserting the FIRST value's wallet proves both that the param is
 * read and that it is normalised, and it fails (with that same TypeError)
 * if the normalisation is dropped.
 */
describe("EditTransactionPage — the ?from return trip", () => {
  it("reads ?from and hands it to the form, normalising a repeated param to its first value", async () => {
    txnById.set(TXN_A, txn(TXN_A));
    walletsById.set(WALLET_A, wallet(WALLET_A));
    categoriesByWalletId.set(WALLET_A, [category(CATEGORY_A)]);

    const ui = await EditTransactionPage({
      params: Promise.resolve({ id: TXN_A }),
      searchParams: Promise.resolve({ from: [`wallet:${WALLET_B}`, `wallet:${WALLET_A}`] }),
    });
    render(ui);

    await userEvent.setup().click(screen.getByRole("button", { name: "Save changes" }));

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith(`/wallets/${WALLET_B}`));
  });

  it("lands on /transactions when there is no ?from, exactly as before", async () => {
    txnById.set(TXN_A, txn(TXN_A));
    walletsById.set(WALLET_A, wallet(WALLET_A));
    categoriesByWalletId.set(WALLET_A, [category(CATEGORY_A)]);

    const ui = await EditTransactionPage({
      params: Promise.resolve({ id: TXN_A }),
      searchParams: Promise.resolve({}),
    });
    render(ui);

    await userEvent.setup().click(screen.getByRole("button", { name: "Save changes" }));

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/transactions"));
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

    const ui = await EditTransactionPage({ params: Promise.resolve({ id: TXN_A }), searchParams: Promise.resolve({}) });
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

/**
 * Task 8, item 2. `/transactions` keeps archived wallets' rows and links each
 * one here, but `updateTransaction`/`updateTransfer` both refuse an archived
 * wallet — so this page used to draw a fully interactive form whose Save
 * could never succeed. See page.tsx's own doc comment for why this renders a
 * distinct read-only state rather than `TransactionNotFound`.
 *
 * Every test here asserts BOTH halves: that the form is gone AND that the
 * explanation is there. "No Save button" alone is satisfied by the page
 * throwing or rendering nothing; "the message appears" alone is satisfied by
 * a page that shows the warning above a working form.
 */
describe("EditTransactionPage — an archived wallet's transaction is read-only", () => {
  it("replaces the form with a reason and the transaction's own values", async () => {
    txnById.set(TXN_A, txn(TXN_A));
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Everyday", archived_at: "2026-01-01T00:00:00Z" }));
    categoriesByWalletId.set(WALLET_A, [category(CATEGORY_A)]);

    const ui = await EditTransactionPage({
      params: Promise.resolve({ id: TXN_A }),
      searchParams: Promise.resolve({}),
    });
    render(ui);

    // The form is GONE — not disabled, not merely warned about. Fails if the
    // `archived_at` guard in page.tsx is removed, or if `archived_at` is
    // dropped from that page's wallet SELECT (undefined is falsy, so the
    // guard silently stops firing).
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Note")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Merchant")).not.toBeInTheDocument();

    // And it is NOT the not-found state — the row exists and the caller can
    // see it on /transactions; saying otherwise would be a lie about a row on
    // their own screen. Fails if this branch is folded into
    // `TransactionNotFound`.
    expect(screen.queryByText("Transaction not found")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "This transaction can’t be edited" })).toBeInTheDocument();
    expect(screen.getByText(/Everyday is archived/)).toBeInTheDocument();

    // The transaction's own values still answer "what was this?".
    expect(screen.getByText("−$12.50")).toBeInTheDocument();
    expect(screen.getByText("2026-08-01")).toBeInTheDocument();
    expect(screen.getByText("Tesco")).toBeInTheDocument();
    expect(screen.getByText("weekly shop")).toBeInTheDocument();
  });

  /**
   * The archived wallet here is the INCOMING leg's — deliberately NOT the
   * wallet of the row the user tapped (`txn()` sets `wallet_id: WALLET_A`,
   * the outgoing leg). A guard written as "is this row's own wallet
   * archived?" would render the form and fail this test; only checking both
   * legs' wallets passes, which is what `updateTransfer` itself requires.
   */
  it("refuses a transfer when the OTHER leg's wallet is archived", async () => {
    txnById.set(
      TXN_A,
      txn(TXN_A, { kind: "transfer", transfer_id: TRANSFER_A, category_id: null, wallet_id: WALLET_A }),
    );
    legsByTransferId.set(TRANSFER_A, [
      { wallet_id: WALLET_A, amount_minor: -5000, currency_code: "USD", occurred_on: "2026-08-02", note: "", merchant: "" },
      { wallet_id: WALLET_B, amount_minor: 5000, currency_code: "USD", occurred_on: "2026-08-02", note: "", merchant: "" },
    ]);
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Everyday" }));
    walletsById.set(WALLET_B, wallet(WALLET_B, { name: "Holiday", archived_at: "2026-01-01T00:00:00Z" }));

    const ui = await EditTransactionPage({
      params: Promise.resolve({ id: TXN_A }),
      searchParams: Promise.resolve({}),
    });
    render(ui);

    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "This transaction can’t be edited" })).toBeInTheDocument();
    // Only the archived one is named. Naming the active wallet too would send
    // the user looking for a problem that isn't there.
    expect(screen.getByText(/^Holiday is archived/)).toBeInTheDocument();
  });

  /**
   * Both legs archived. Pins that the page collects EVERY archived wallet
   * rather than the first one it finds: naming only one would send the user
   * to un-archive that wallet and discover the form still refuses.
   */
  it("names both wallets when a transfer has two archived legs", async () => {
    txnById.set(
      TXN_A,
      txn(TXN_A, { kind: "transfer", transfer_id: TRANSFER_A, category_id: null, wallet_id: WALLET_A }),
    );
    legsByTransferId.set(TRANSFER_A, [
      { wallet_id: WALLET_A, amount_minor: -5000, currency_code: "USD", occurred_on: "2026-08-02", note: "", merchant: "" },
      { wallet_id: WALLET_B, amount_minor: 5000, currency_code: "USD", occurred_on: "2026-08-02", note: "", merchant: "" },
    ]);
    walletsById.set(WALLET_A, wallet(WALLET_A, { name: "Everyday", archived_at: "2026-01-01T00:00:00Z" }));
    walletsById.set(WALLET_B, wallet(WALLET_B, { name: "Holiday", archived_at: "2026-01-01T00:00:00Z" }));

    const ui = await EditTransactionPage({
      params: Promise.resolve({ id: TXN_A }),
      searchParams: Promise.resolve({}),
    });
    render(ui);

    expect(screen.getByText(/^Everyday and Holiday are archived/)).toBeInTheDocument();
  });
});
