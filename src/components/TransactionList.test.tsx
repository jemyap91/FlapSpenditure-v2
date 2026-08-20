import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TransactionList, type Row } from "./TransactionList";
import { softDeleteTransaction, restoreTransaction } from "@/server/actions/transactions";

/**
 * `@/server/actions/transactions` carries a file-level `"use server"` and
 * (transitively, through `@/lib/supabase/server`) reaches `next/headers`
 * and `server-only` — exactly what this branch's binding rule says a unit
 * test's import chain must never touch (`npm test` runs with no
 * `.env.local`). `vi.mock` intercepts the import BEFORE that real module
 * ever executes, so the mock factory below is all this file's import of
 * `softDeleteTransaction`/`restoreTransaction` actually resolves to — the
 * real Supabase-backed implementation, and everything it drags in, is
 * never loaded.
 */
vi.mock("@/server/actions/transactions", () => ({
  softDeleteTransaction: vi.fn(),
  restoreTransaction: vi.fn(),
}));

// `useRouter` is only used here for `.refresh()` (see TransactionList's own
// doc comment on why the error branches call it) — `vi.hoisted` is needed
// because `vi.mock` factories are hoisted above this file's own top-level
// `const`s, so a plain closure over `refresh` declared below would throw
// "Cannot access 'refresh' before initialization."
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

const baseRow: Row = {
  id: "row-1",
  kind: "expense",
  amount_minor: -1250,
  currency_code: "USD",
  occurred_on: "2026-08-18",
  wallet_name: "USD Checking",
  note: null,
  category_name: "Groceries",
  category_icon: "shopping-basket",
  color_slot: 1,
  created_by_name: null,
};

// Matches whichever row's Delete button is rendered — the accessible name
// includes the row's own label ("Groceries"/"Transfer"/"Uncategorised")
// plus its amount (review-caught disambiguation, see TransactionList.tsx),
// so a fixed string here would only work for one row's label.
async function clickDelete() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^Delete /i }));
  return user;
}

describe("TransactionList — delete/undo state machine", () => {
  beforeEach(() => {
    vi.mocked(softDeleteTransaction).mockReset();
    vi.mocked(restoreTransaction).mockReset();
    refresh.mockReset();
  });

  it("a successful delete shows the undo toast, offering Undo", async () => {
    vi.mocked(softDeleteTransaction).mockResolvedValue({ ok: true });
    render(<TransactionList rows={[baseRow]} />);

    await clickDelete();

    expect(await screen.findByText("Groceries deleted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("a failed delete leaves the row's own Delete button as the retry path and surfaces the error with no toast action", async () => {
    vi.mocked(softDeleteTransaction).mockResolvedValue({ error: "Could not update transaction" });
    render(<TransactionList rows={[baseRow]} />);

    await clickDelete();

    // Two nodes carry this text on a plain (no-action) error toast: the
    // always-mounted sr-only announcer and the visible message span (see
    // UndoToast's doc comment) — both matching confirms the failure is
    // both announced AND shown, not just one or the other.
    expect(await screen.findAllByText("Could not update transaction")).toHaveLength(2);
    // Nothing was actually deleted (a single UPDATE statement is atomic),
    // so the row's own Delete button — the real retry path — is still
    // there, and the toast itself offers no action of its own.
    expect(screen.getByRole("button", { name: /^Delete /i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    // The list is reconciled against the server even on failure, in case
    // this specific error ever did leave a partial change.
    expect(refresh).toHaveBeenCalled();
  });

  it("a partial-transfer delete failure still offers Undo, since some rows genuinely were soft-deleted", async () => {
    vi.mocked(softDeleteTransaction).mockResolvedValue({
      error: "Only part of this transfer could be updated",
    });
    render(<TransactionList rows={[{ ...baseRow, kind: "transfer", category_name: null }]} />);

    await clickDelete();

    expect(await screen.findByText("Only part of this transfer could be updated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("a failed RETRYABLE undo keeps the action available, relabelled Retry, instead of destroying the only recovery path", async () => {
    vi.mocked(softDeleteTransaction).mockResolvedValue({ ok: true });
    vi.mocked(restoreTransaction).mockResolvedValue({ error: "Not signed in" });
    render(<TransactionList rows={[baseRow]} />);

    const user = await clickDelete();
    await user.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Not signed in")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("a NOT-FOUND undo drops the action — nothing left to act on", async () => {
    vi.mocked(softDeleteTransaction).mockResolvedValue({ ok: true });
    vi.mocked(restoreTransaction).mockResolvedValue({ error: "Transaction not found" });
    render(<TransactionList rows={[baseRow]} />);

    const user = await clickDelete();
    await user.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findAllByText("Transaction not found")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("a successful undo clears the toast entirely", async () => {
    vi.mocked(softDeleteTransaction).mockResolvedValue({ ok: true });
    vi.mocked(restoreTransaction).mockResolvedValue({ ok: true });
    render(<TransactionList rows={[baseRow]} />);

    const user = await clickDelete();
    await user.click(await screen.findByRole("button", { name: "Undo" }));

    // The toast's message text is gone once cleared; the visible box (with
    // Undo/Retry/Dismiss) unmounts along with it.
    expect(screen.queryByText("Groceries deleted")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss notification" })).not.toBeInTheDocument();
  });
});

/**
 * `note` (the transactions table's own `text` column, <=280 chars) is what a
 * user types to name a transaction — typically a merchant. The column, the
 * zod schemas and both server actions have always written it; nothing
 * displayed it.
 */
describe("TransactionList — note", () => {
  it("shows the note as the row's primary line, with the category demoted beside the wallet", () => {
    render(
      <TransactionList
        rows={[{ ...baseRow, note: "Starbucks", category_name: "Coffee", wallet_name: "Everyday" }]}
      />,
    );
    expect(screen.getByText("Starbucks")).toBeInTheDocument();
    // The category is not lost — it moves to the secondary line next to the
    // wallet, so no information the row used to carry disappears.
    expect(screen.getByText("Coffee · Everyday")).toBeInTheDocument();
  });

  it("falls back to the category as the primary line when there is no note", () => {
    render(<TransactionList rows={[{ ...baseRow, note: null, category_name: "Coffee", wallet_name: "Everyday" }]} />);
    expect(screen.getByText("Coffee")).toBeInTheDocument();
    expect(screen.getByText("Everyday")).toBeInTheDocument();
    expect(screen.queryByText("Coffee · Everyday")).not.toBeInTheDocument();
  });

  it("names the Delete button after the note, matching what is on screen", () => {
    render(<TransactionList rows={[{ ...baseRow, note: "Starbucks", category_name: "Coffee" }]} />);
    // Would otherwise read "Delete Coffee, ..." while the row visibly says
    // "Starbucks" — a screen-reader user and a sighted user must be told the
    // same thing about the same button.
    expect(screen.getByRole("button", { name: /Delete Starbucks/ })).toBeInTheDocument();
  });

  it("says the note in the deletion toast rather than the category", async () => {
    vi.mocked(softDeleteTransaction).mockResolvedValue({} as never);
    const user = userEvent.setup();
    render(<TransactionList rows={[{ ...baseRow, note: "Starbucks", category_name: "Coffee" }]} />);
    await user.click(screen.getByRole("button", { name: /Delete Starbucks/ }));
    expect(await screen.findByText("Starbucks deleted", { exact: true })).toBeInTheDocument();
  });

  it("treats an empty-string note as absent, not as a blank primary line", () => {
    // The zod schema accepts `""` and the actions coerce it to null, but a
    // row that reaches the client as "" must not render an empty heading.
    render(<TransactionList rows={[{ ...baseRow, note: "", category_name: "Coffee" }]} />);
    expect(screen.getByText("Coffee")).toBeInTheDocument();
  });
});

/**
 * Attribution renders ONLY when the caller tells us the wallet has more
 * than one member (`showAttribution`) — a solo wallet would otherwise show
 * "added by you" on every row, which is noise, not information. The page
 * computes that boolean from membership counts, not this component.
 */
describe("TransactionList — attribution", () => {
  it("says who added a row when the wallet has more than one member", () => {
    render(
      <TransactionList
        rows={[{ ...baseRow, created_by_name: "Sam", note: "Starbucks", category_name: "Coffee" }]}
        showAttribution
      />,
    );
    expect(screen.getByText(/added by Sam/i)).toBeInTheDocument();
  });

  it("stays silent in a single-member wallet, where every row would say 'you'", () => {
    render(
      <TransactionList
        rows={[{ ...baseRow, created_by_name: "Sam", note: "Starbucks", category_name: "Coffee" }]}
        showAttribution={false}
      />,
    );
    expect(screen.queryByText(/added by/i)).not.toBeInTheDocument();
  });

  it("omits attribution for a row whose author is unknown", () => {
    // created_by is ON DELETE SET NULL, so a removed account leaves rows with
    // no author rather than deleting the ledger history.
    render(
      <TransactionList rows={[{ ...baseRow, created_by_name: null }]} showAttribution />,
    );
    expect(screen.queryByText(/added by/i)).not.toBeInTheDocument();
  });

  /**
   * Regression guard for round-1 review's Critical: on a page mixing one
   * solo-wallet transaction with one shared-wallet transaction,
   * `showAttribution` is a single page-level boolean (true because the
   * page has a shared-wallet row at all) — so this component's render
   * check must depend on EACH ROW's own `created_by_name` being non-null,
   * never render attribution just because `showAttribution` is true
   * globally. The actual bug lived in how `page.tsx` computed
   * `created_by_name` for the solo row (see
   * `src/app/(app)/transactions/attribution.test.ts`, which reproduces and
   * fixes that computation directly) — this test instead pins down this
   * component's half of the contract: given a correctly-computed mixed
   * `rows` array (solo row's name genuinely null, shared row's resolved),
   * one page-level `showAttribution` must still render per-row, not
   * uniformly.
   */
  it("on a mixed page, shows attribution only on the shared-wallet row, not the solo one", () => {
    render(
      <TransactionList
        rows={[
          { ...baseRow, id: "solo-row", note: "Coffee run", category_name: "Coffee", wallet_name: "Personal", created_by_name: null },
          { ...baseRow, id: "shared-row", note: "Groceries", category_name: "Food", wallet_name: "Household", created_by_name: "Alex" },
        ]}
        showAttribution
      />,
    );
    expect(screen.getByText(/added by Alex/i)).toBeInTheDocument();
    // Exactly one row's secondary line mentions attribution — the solo
    // row's own line ("Coffee · Personal") must not gain an "added by"
    // segment just because showAttribution is true page-wide.
    expect(screen.getAllByText(/added by/i)).toHaveLength(1);
    expect(screen.getByText("Coffee · Personal")).toBeInTheDocument();
  });
});
