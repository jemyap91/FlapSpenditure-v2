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
  merchant: null,
  note: null,
  category_name: "Groceries",
  category_icon: "shopping-basket",
  color_slot: 1,
  created_by_name: null,
};

// Overrides layered onto `baseRow` — the merchant tests below use this
// factory verbatim, matching this task's brief.
function row(overrides: Partial<Row> = {}): Row {
  return { ...baseRow, ...overrides };
}

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
 * `merchant` (the transactions table's own `text` column, <=120 chars, Task
 * 1 of this plan) outranks `note` as the row's primary line — it is the
 * most specific name available for a transaction, structured rather than
 * freeform. When both are present the note does not disappear; it demotes
 * to the secondary line beside the category, the same way the category
 * itself already demotes when a note alone took the primary line.
 */
describe("TransactionList — merchant", () => {
  it("uses the merchant as the row's primary line when present", () => {
    render(<TransactionList rows={[row({ merchant: "Tesco", note: "weekly shop" })]} />);
    expect(screen.getByText("Tesco")).toBeInTheDocument();
  });

  it("demotes the note beside the category when a merchant is present", () => {
    render(
      <TransactionList rows={[row({ merchant: "Tesco", note: "weekly shop", category_name: "Groceries" })]} />,
    );
    expect(screen.getByText(/weekly shop/)).toBeInTheDocument();
    expect(screen.getByText(/Groceries/)).toBeInTheDocument();
  });

  it("falls back to the note exactly as before when there is no merchant", () => {
    // Additive: a row with no merchant must render precisely as it does today.
    render(<TransactionList rows={[row({ merchant: null, note: "weekly shop" })]} />);
    expect(screen.getByText("weekly shop")).toBeInTheDocument();
  });

  it("treats a blank merchant as absent", () => {
    render(<TransactionList rows={[row({ merchant: "   ", note: "weekly shop" })]} />);
    expect(screen.getByText("weekly shop")).toBeInTheDocument();
  });

  it("names the Delete button after the merchant when there is one", () => {
    // rowLabel drives the Delete aria-label and the toast; a row that announces
    // one name and a delete button that announces another is the defect here.
    render(<TransactionList rows={[row({ merchant: "Tesco", amount_minor: -1800 })]} />);
    expect(screen.getByRole("button", { name: /Delete Tesco/ })).toBeInTheDocument();
  });

  it("still shows the category in the secondary line for a merchant-only row (no note)", () => {
    // Fix round 1: the secondary-line category condition is
    // `(merchantOf(r) || noteOf(r)) && r.category_name` — merchant-blind
    // `noteOf(r) && r.category_name` (the pre-existing form) differs from it
    // in exactly this case: merchant present, note absent. Every other test
    // in this describe block also sets `note`, so none of them catches a
    // regression back to the merchant-blind form — this is the commonest
    // row shape once merchants are in use, and the one every other case
    // here happens to skip.
    render(<TransactionList rows={[row({ merchant: "Tesco", note: null, category_name: "Groceries" })]} />);
    expect(screen.getByText("Tesco")).toBeInTheDocument();
    expect(screen.getByText(/Groceries/)).toBeInTheDocument();
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

/**
 * Task 6 (editable-transactions plan): the row's entry point into editing
 * it. Deliberately NOT the whole row — each row already contains a Delete
 * `<button>`, and wrapping that in a link would nest one interactive
 * element inside another (invalid HTML, ambiguous click target).
 * `WalletList.tsx` already solved this exact problem (the wallet's NAME is
 * the link, not the row); this follows that precedent, so the row's primary
 * label (merchant → note → category, `rowLabel`) is the link.
 */
describe("TransactionList — edit entry point (Task 6)", () => {
  it("links the row's primary label to that transaction's edit route", () => {
    render(<TransactionList rows={[{ ...baseRow, id: "row-42", category_name: "Groceries" }]} />);
    const link = screen.getByRole("link", { name: "Groceries" });
    expect(link).toHaveAttribute("href", "/transactions/row-42/edit");
  });

  it("names the link after merchant/note, matching the Delete button's own accessible name", () => {
    render(<TransactionList rows={[row({ id: "row-7", merchant: "Tesco" })]} />);
    // The link's accessible name is `rowLabel`'s output alone — nothing
    // else inside the anchor — so it matches what Delete already announces
    // (`Delete ${label}, ${amountText}`): a row cannot name itself one
    // thing to a link and another to its delete control.
    expect(screen.getByRole("link", { name: "Tesco" })).toHaveAttribute(
      "href",
      "/transactions/row-7/edit",
    );
    expect(screen.getByRole("button", { name: /^Delete Tesco/ })).toBeInTheDocument();
  });

  it("does not make the whole row a link — Delete is its own, separate control", () => {
    render(<TransactionList rows={[{ ...baseRow, id: "row-1", category_name: "Groceries" }]} />);
    // Exactly one link and one button, sharing no DOM ancestor-descendant
    // relationship of one wrapping the other — the failure mode this
    // guards is a link wrapping the Delete button (invalid HTML: a button
    // nested inside an anchor).
    const link = screen.getByRole("link", { name: "Groceries" });
    const del = screen.getByRole("button", { name: /^Delete /i });
    expect(link.contains(del)).toBe(false);
    expect(del.contains(link)).toBe(false);
  });

  it("Delete still works with the label now a link (link and delete are independent controls)", async () => {
    vi.mocked(softDeleteTransaction).mockResolvedValue({ ok: true });
    render(<TransactionList rows={[{ ...baseRow, id: "row-9", category_name: "Groceries" }]} />);

    await clickDelete();

    expect(await screen.findByText("Groceries deleted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });
});
