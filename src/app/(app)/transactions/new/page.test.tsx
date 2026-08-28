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
// src/app/(app)/wallets/[id]/page.test.tsx mocks this module. `push` is a
// module-level mock (not created fresh per-test inline), same pattern as
// TransactionForm.test.tsx, so the "threads `from` through" and
// "array-valued `from` doesn't crash" tests below (review round 1, fixes 1
// and 2) can assert on the actual navigation target after a save.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTransaction } from "@/server/actions/transactions";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

// TransactionForm mounts CategoryPicker, which independently imports
// `@/server/actions/categories` (a "use server" module) to inline-create a
// category — mocked for the same reason TransactionForm.test.tsx mocks it,
// even though these new tests never exercise inline creation.
vi.mock("@/server/actions/transactions", () => ({
  createTransaction: vi.fn(),
  createTransfer: vi.fn(),
}));

vi.mock("@/server/actions/categories", () => ({
  createCategory: vi.fn(),
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
  push.mockClear();
  vi.mocked(createTransaction).mockReset();
  vi.mocked(createTransaction).mockResolvedValue({ id: "t1" });
});

/** Fills the minimum a save needs (a nonzero amount, a category) and clicks
 *  Save, then waits for the redirect that follows a successful save — same
 *  helper shape as TransactionForm.test.tsx's `saveAnExpense`, but driven
 *  through the page (so it also exercises the page's own `searchParams`
 *  normalisation, not just the form). Requires `categoriesData` to contain
 *  at least one expense category for WALLET_A before calling. */
async function saveAnExpenseThroughThePage() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "5" }));
  await user.click(screen.getByRole("button", { name: "Groceries" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(push).toHaveBeenCalled());
}

describe("NewTransactionPage — ?wallet preselects, but only from the caller's own list", () => {
  it("preselects the wallet named by ?wallet", async () => {
    const ui = await NewTransactionPage({
      searchParams: Promise.resolve({ wallet: WALLET_B }),
    });
    render(ui);

    expect(screen.getByRole("combobox", { name: "Wallet" })).toHaveValue(WALLET_B);
  });

  it("falls back to the default wallet when ?wallet names one the caller cannot see, rather than erroring", async () => {
    // Needed so the state-driven assertion below has something to click —
    // scoped to THIS test only (not the describe block's `beforeEach`),
    // so the other three tests here are untouched.
    categoriesData.push({
      id: "cat-1",
      name: "Groceries",
      kind: "expense",
      color_slot: 1,
      icon: "circle",
      wallet_id: WALLET_A,
    });

    const ui = await NewTransactionPage({
      searchParams: Promise.resolve({ wallet: NOT_MINE }),
    });
    render(ui);

    // Silently falls back to the first wallet in the caller's own
    // RLS-scoped list — never a distinguishable error, and never the
    // supplied (invisible) wallet.
    //
    // This `<select>` assertion alone does NOT discriminate between the
    // real membership check and a mutant that trusts `?wallet` outright
    // (`wallets.find((w) => w.id === wallet)?.id` weakened to just
    // `wallet`): React renders `<select value=…>` by marking the matching
    // `<option>` selected, and when NOTHING matches (as here, under both
    // implementations — NOT_MINE names no `<option>` either way) the DOM
    // itself auto-selects the first option, which happens to be WALLET_A.
    // That is the browser's fallback rendering the mutant's WRONG state
    // (`defaultWalletId = NOT_MINE`) exactly as if it were the app's own
    // correct fallback (`defaultWalletId = WALLET_A`) — kept here anyway
    // (not weakened) because it does confirm the fallback UX, just not the
    // security property.
    expect(screen.getByRole("combobox", { name: "Wallet" })).toHaveValue(WALLET_A);

    // The state-driven assertion: `walletCategories` (TransactionForm) is
    // derived by filtering on the RESOLVED wallet id, not the `<select>`'s
    // rendered value — so it reflects the app's real decision even where
    // the DOM's own fallback would paper over a wrong one. Under the real
    // membership check this resolves to WALLET_A, whose "Groceries"
    // category (seeded above) renders; under the mutant it resolves to
    // NOT_MINE, whose category list is empty, and this button does not
    // exist.
    expect(screen.getByRole("button", { name: "Groceries" })).toBeInTheDocument();

    // Belt-and-suspenders on the same property: drive an actual save and
    // assert the `wallet_id` `createTransaction` receives is WALLET_A, not
    // the caller-supplied NOT_MINE — the field the server action itself
    // re-validates membership on (src/server/actions/transactions.ts).
    await saveAnExpenseThroughThePage();
    expect(createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ wallet_id: WALLET_A }),
    );
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

// Review round 1, fix 1: Next's own generated route type for this page is
// `Record<string, string | string[] | undefined>` (.next/types/routes.d.ts)
// — a claim this file's `searchParams: Promise<{ wallet?: string; from?:
// string }>` annotation never actually checked (Next's generated page-prop
// validator widens with `& any`; see .next/types/validator.ts). A URL with a
// repeated param (`?from=a&from=b`) therefore delivers a real `string[]` at
// runtime. Before the fix, that array reached `parseOrigin`
// (src/lib/origin.ts) inside TransactionForm's post-save transition, where
// `!from` is false and `from.split` is not a function — a TypeError thrown
// AFTER `createTransaction` had already succeeded, leaving the user on an
// error boundary despite the row being saved. The fix normalises both
// params to their first value at the page boundary, without touching
// `src/lib/origin.ts` (frozen — 15 tests pin its `string | null |
// undefined` contract).
describe("NewTransactionPage — array-valued search params do not crash (Task 4 review round 1, fix 1)", () => {
  beforeEach(() => {
    categoriesData.push({
      id: "cat-1",
      name: "Groceries",
      kind: "expense",
      color_slot: 1,
      icon: "circle",
      wallet_id: WALLET_A,
    });
  });

  it("normalises a repeated `from` to its first value and redirects there, instead of throwing", async () => {
    const ui = await NewTransactionPage({
      // A repeated `?from=` param, exactly as a real browser would deliver
      // it to `searchParams` for `/transactions/new?from=wallet:B&from=wallet:ignored-second-value`.
      searchParams: Promise.resolve({ from: [`wallet:${WALLET_B}`, `wallet:${WALLET_A}`] }),
    });

    // The bug this closes threw INSIDE the render/transition, not before
    // it — so the assertion is on the redirect that follows a real save,
    // not merely that `NewTransactionPage` itself didn't throw.
    render(ui);
    await saveAnExpenseThroughThePage();

    expect(push).toHaveBeenCalledWith(`/wallets/${WALLET_B}`);
  });

  it("normalises a repeated `wallet` to its first value, exactly as the single-value case already does", async () => {
    const ui = await NewTransactionPage({
      searchParams: Promise.resolve({ wallet: [WALLET_B, WALLET_A] }),
    });
    render(ui);

    expect(screen.getByRole("combobox", { name: "Wallet" })).toHaveValue(WALLET_B);
  });
});

// Review round 1, fix 2: deleting `from={from}` at new/page.tsx used to
// leave the whole suite green — TransactionForm.test.tsx passes `from`
// directly as a prop, and this file never exercised it at all. This test
// closes that seam by driving an actual save through the PAGE (not the
// form directly) and asserting the FAB's entire return trip — `from`
// arriving via the URL, through the page, into the form, out through
// `parseOrigin`, into `router.push` — still works end to end.
describe("NewTransactionPage — threads `from` into TransactionForm (Task 4 review round 1, fix 2)", () => {
  beforeEach(() => {
    categoriesData.push({
      id: "cat-1",
      name: "Groceries",
      kind: "expense",
      color_slot: 1,
      icon: "circle",
      wallet_id: WALLET_A,
    });
  });

  it("returns to the originating wallet after a save when ?from names one", async () => {
    const ui = await NewTransactionPage({
      searchParams: Promise.resolve({ from: `wallet:${WALLET_B}` }),
    });
    render(ui);
    await saveAnExpenseThroughThePage();

    expect(push).toHaveBeenCalledWith(`/wallets/${WALLET_B}`);
  });
});
