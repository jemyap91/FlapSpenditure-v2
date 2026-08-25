// src/app/(app)/budgets/BudgetList.test.tsx
//
// `BudgetStatusRow` is imported from "@/lib/budget-status", NOT redefined
// or re-exported here — see that file's own doc comment: it is the
// nullability-corrected shape of `get_budget_status`'s (0012) generated
// row type, added specifically so this UI cannot dereference a null
// `category_id`/`category_name`/`color_slot`/`icon`/`budget_minor`/
// `budget_id`/`budget_period_start`. Redefining it locally (as an earlier
// draft of this task's brief showed) would silently reintroduce the exact
// bug that type exists to prevent.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BudgetList } from "./BudgetList";
import { removeBudget } from "@/server/actions/budgets";
import type { BudgetStatusRow } from "@/lib/budget-status";

vi.mock("@/server/actions/budgets", () => ({ setBudget: vi.fn(), removeBudget: vi.fn() }));

const row = (over: Partial<BudgetStatusRow>): BudgetStatusRow => ({
  wallet_id: "w1", wallet_name: "Test", currency_code: "SGD",
  category_id: "c1", category_name: "Groceries", color_slot: 1, icon: "shopping-basket",
  spent_minor: 0, budget_minor: null, budget_id: null, budget_period_start: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(removeBudget).mockResolvedValue({});
});

describe("BudgetList", () => {
  it("shows spending against its budget in figures, not only a bar", () => {
    render(<BudgetList rows={[row({ spent_minor: 41200, budget_minor: 60000 })]} />);
    expect(screen.getByText(/SGD 412\.00/)).toBeInTheDocument();
    expect(screen.getByText(/SGD 600\.00/)).toBeInTheDocument();
    expect(screen.getByText(/69%/)).toBeInTheDocument();
  });

  it("states an overrun in words, never by colour alone", () => {
    render(<BudgetList rows={[row({ spent_minor: 24500, budget_minor: 20000 })]} />);
    // A screen reader user and a sighted user must get the same information.
    expect(screen.getByText(/over by SGD 45\.00/i)).toBeInTheDocument();
  });

  it("shows an unbudgeted category as untracked, not as 100% over — no percent, no bar", () => {
    const { container } = render(<BudgetList rows={[row({ spent_minor: 9000, budget_minor: null })]} />);
    expect(screen.getByText(/no budget set/i)).toBeInTheDocument();
    expect(screen.queryByText(/over by/i)).not.toBeInTheDocument();
    // Step 3 requires BOTH "no percent" and "no bar" for a null budget —
    // an absence-only check on "over by" alone would still pass a
    // regression that folded a null budget into `budget_minor ?? 0`
    // (budgetProgress treats any non-positive budget as untracked too, so
    // that specific regression happens to still read "no budget set", but
    // it would also start rendering a 0%-wide bar and "0%" text, which
    // these two assertions catch).
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    // The bar has no accessible role (deliberately `aria-hidden` — the
    // paragraph above already carries the meaning), so it can only be
    // checked via the DOM directly. CategoryBreakdown.test.tsx's own mini-
    // bar assertion (`table.querySelector("td div div")`) is the same
    // "query the container directly for a decorative node" precedent.
    expect(container.querySelector(".h-2")).not.toBeInTheDocument();
  });

  it("labels the wallet-wide cap distinctly from a category", () => {
    render(<BudgetList rows={[row({ category_id: null, category_name: null, spent_minor: 74500, budget_minor: 95000 })]} />);
    expect(screen.getByText(/All spending/i)).toBeInTheDocument();
  });

  it("groups rows under their wallet, so two wallets never blur together, under level-2 headings", () => {
    render(
      <BudgetList
        rows={[
          row({ wallet_id: "w1", wallet_name: "Test", category_name: "Groceries" }),
          row({ wallet_id: "w2", wallet_name: "Citi", category_id: "c2", category_name: "Transport" }),
        ]}
      />,
    );
    // `level: 2` pinned explicitly — `getByRole("heading")` alone matches
    // h1-h6, so an h2 -> h3 regression would pass silently otherwise, and
    // the controller addendum pins this as an <h2> specifically.
    expect(screen.getByRole("heading", { level: 2, name: "Test" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Citi" })).toBeInTheDocument();
  });
});

describe("BudgetList — Remove", () => {
  it("offers Remove, pinned by name, on a category budget with a resolvable id", () => {
    render(
      <BudgetList
        rows={[row({ category_name: "Groceries", budget_minor: 30000, budget_id: "b1", budget_period_start: "2026-08-01" })]}
        currentPeriodStart="2026-08-01"
      />,
    );
    expect(screen.getByRole("button", { name: "Remove budget for Groceries" })).toBeInTheDocument();
  });

  it("offers Remove, pinned by name, on the overall cap with a resolvable id", () => {
    render(
      <BudgetList
        rows={[row({ category_id: null, category_name: null, budget_minor: 30000, budget_id: "b1", budget_period_start: "2026-08-01" })]}
        currentPeriodStart="2026-08-01"
      />,
    );
    expect(screen.getByRole("button", { name: "Remove overall budget" })).toBeInTheDocument();
  });

  it("never renders Remove for a row with no resolvable budget id", () => {
    render(<BudgetList rows={[row({ budget_minor: null, budget_id: null })]} />);
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it("discloses a budget carried forward from an earlier month in the VISIBLE text, keeping the aria-label pinned", () => {
    render(
      <BudgetList
        rows={[row({ category_name: "Groceries", budget_minor: 30000, budget_id: "b1", budget_period_start: "2026-06-01" })]}
        currentPeriodStart="2026-08-01"
      />,
    );
    const button = screen.getByRole("button", { name: "Remove budget for Groceries" });
    // The aria-label (queried above) is the pinned string, byte-identical.
    // The VISIBLE text is what carries the disclosure — a screen reader
    // user gets the label either way, since it's not a stated requirement
    // there; a sighted user gets the qualifier before clicking.
    expect(button).toHaveTextContent("Remove (set Jun)");
  });

  it("does not disclose a past-month qualifier for a budget set THIS month", () => {
    render(
      <BudgetList
        rows={[row({ category_name: "Groceries", budget_minor: 30000, budget_id: "b1", budget_period_start: "2026-08-01" })]}
        currentPeriodStart="2026-08-01"
      />,
    );
    const button = screen.getByRole("button", { name: "Remove budget for Groceries" });
    expect(button).toHaveTextContent("Remove");
    expect(button).not.toHaveTextContent(/\(set/);
  });

  it("clicking Remove calls removeBudget with the row's real budget id", async () => {
    const user = userEvent.setup();
    render(
      <BudgetList
        rows={[row({ category_name: "Groceries", budget_minor: 30000, budget_id: "b1", budget_period_start: "2026-08-01" })]}
        currentPeriodStart="2026-08-01"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove budget for Groceries" }));
    expect(removeBudget).toHaveBeenCalledExactlyOnceWith("b1");
  });

  it("surfaces a Remove failure in its OWN row's alert, named for that row", async () => {
    vi.mocked(removeBudget).mockResolvedValue({ error: "Could not remove that budget. Please try again." });
    const user = userEvent.setup();
    render(
      <BudgetList
        rows={[row({ category_name: "Groceries", budget_minor: 30000, budget_id: "b1", budget_period_start: "2026-08-01" })]}
        currentPeriodStart="2026-08-01"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove budget for Groceries" }));
    expect(await screen.findByRole("alert", { name: "Error for Groceries" })).toHaveTextContent(
      "Could not remove that budget. Please try again.",
    );
  });
});
