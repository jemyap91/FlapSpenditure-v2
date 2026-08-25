// src/app/(app)/budgets/BudgetList.test.tsx
//
// `BudgetStatusRow` is imported from "@/lib/budget-status", NOT redefined
// or re-exported here — see that file's own doc comment: it is the
// nullability-corrected shape of `get_budget_status`'s (0012) generated
// row type, added specifically so this UI cannot dereference a null
// `category_id`/`category_name`/`color_slot`/`icon`/`budget_minor`.
// Redefining it locally (as an earlier draft of this task's brief showed)
// would silently reintroduce the exact bug that type exists to prevent.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { BudgetList } from "./BudgetList";
import type { BudgetStatusRow } from "@/lib/budget-status";

vi.mock("@/server/actions/budgets", () => ({ setBudget: vi.fn(), removeBudget: vi.fn() }));

const row = (over: Partial<BudgetStatusRow>): BudgetStatusRow => ({
  wallet_id: "w1", wallet_name: "Test", currency_code: "SGD",
  category_id: "c1", category_name: "Groceries", color_slot: 1, icon: "shopping-basket",
  spent_minor: 0, budget_minor: null, ...over,
});

beforeEach(() => vi.clearAllMocks());

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

  it("shows an unbudgeted category as untracked, not as 100% over", () => {
    render(<BudgetList rows={[row({ spent_minor: 9000, budget_minor: null })]} />);
    expect(screen.getByText(/no budget set/i)).toBeInTheDocument();
    expect(screen.queryByText(/over by/i)).not.toBeInTheDocument();
  });

  it("labels the wallet-wide cap distinctly from a category", () => {
    render(<BudgetList rows={[row({ category_id: null, category_name: null, spent_minor: 74500, budget_minor: 95000 })]} />);
    expect(screen.getByText(/All spending/i)).toBeInTheDocument();
  });

  it("groups rows under their wallet, so two wallets never blur together", () => {
    render(
      <BudgetList
        rows={[
          row({ wallet_id: "w1", wallet_name: "Test", category_name: "Groceries" }),
          row({ wallet_id: "w2", wallet_name: "Citi", category_id: "c2", category_name: "Transport" }),
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Test" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Citi" })).toBeInTheDocument();
  });
});
