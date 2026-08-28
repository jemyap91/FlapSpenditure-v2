// src/components/BudgetSummary.test.tsx
//
// Dashboard's all-wallets budget block (task-7-brief.md + CONTROLLER
// ADDENDUM). `BudgetStatusRow` is imported from "@/lib/budget-status", never
// redefined here -- same reasoning BudgetList.test.tsx's own doc comment
// gives: a local shadow of the generated+narrowed row type is exactly the
// mistake that shipped an `undefined 2026` heading on the previous branch.
//
// This block is the "all wallets" view only (controller addendum §2): a
// budget whose wallet set covers only a SUBSET of the caller's active
// wallets in that currency is a /budgets-only concern and must never appear
// here, no matter how it's spending.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BudgetSummary } from "./BudgetSummary";
import type { BudgetStatusRow } from "@/lib/budget-status";

/** A BUDGETED row covering every one of 2 active SGD wallets, matching the
 *  "budget row" shape `get_budget_status` emits (controller addendum §4). */
const row = (over: Partial<BudgetStatusRow> = {}): BudgetStatusRow => ({
  budget_id: "b1",
  category_key: "groceries",
  category_label: "Groceries",
  currency_code: "SGD",
  wallet_names: ["Everyday", "Savings"],
  wallet_count: 2,
  spent_minor: 0,
  budget_minor: 60000,
  budget_period_start: "2026-08-01",
  ...over,
});

describe("BudgetSummary — scope filtering (all-wallets only)", () => {
  it("shows a budget whose wallet set covers every active wallet in that currency", () => {
    render(<BudgetSummary rows={[row({ spent_minor: 41200 })]} currencyCode="SGD" walletCount={2} />);
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText(/SGD 412\.00 of SGD 600\.00 · 69%/)).toBeInTheDocument();
    // N7b (whole-branch review): positive control for the empty state's own
    // `.h-2` ABSENCE assertion below — without this, a rename of the bar's
    // class would make that absence check pass vacuously forever instead of
    // catching drift, the exact bug already fixed in BudgetList.test.tsx's
    // sibling assertion (see its own comment on the same pattern).
    expect(document.querySelector(".h-2")).toBeInTheDocument();
  });

  it("hides a budget over only a SUBSET of wallets (a /budgets-only concern)", () => {
    render(
      <BudgetSummary
        rows={[row({ wallet_names: ["Everyday"], wallet_count: 1 })]}
        currencyCode="SGD"
        walletCount={2}
      />,
    );
    expect(screen.queryByText("Groceries")).not.toBeInTheDocument();
    expect(screen.getByText(/no budgets cover every wallet/i)).toBeInTheDocument();
  });

  it("hides an uncovered-spending row (budget_id null) rather than treating a null wallet_count as a match", () => {
    render(
      <BudgetSummary
        rows={[
          row({
            budget_id: null,
            wallet_names: null,
            wallet_count: null,
            budget_minor: null,
            budget_period_start: null,
          }),
        ]}
        currencyCode="SGD"
        walletCount={2}
      />,
    );
    expect(screen.getByText(/no budgets cover every wallet/i)).toBeInTheDocument();
  });

  it("hides a budget in a different currency than the dashboard's primary one", () => {
    render(<BudgetSummary rows={[row({ currency_code: "USD" })]} currencyCode="SGD" walletCount={2} />);
    expect(screen.getByText(/no budgets cover every wallet/i)).toBeInTheDocument();
  });
});

describe("BudgetSummary — over-budget stated in words", () => {
  it("states an overrun in words, in its own paragraph, not colour alone", () => {
    render(
      <BudgetSummary rows={[row({ spent_minor: 65000, budget_minor: 60000 })]} currencyCode="SGD" walletCount={2} />,
    );
    const overPara = screen.getByText(/over by SGD 50\.00/i);
    expect(overPara.tagName).toBe("P");
  });

  it("does not state an overrun for a row within budget", () => {
    render(<BudgetSummary rows={[row({ spent_minor: 100 })]} currencyCode="SGD" walletCount={2} />);
    expect(screen.queryByText(/over by/i)).not.toBeInTheDocument();
  });
});

describe("BudgetSummary — empty state", () => {
  it("renders one explanatory line and no empty chrome when nothing covers all wallets", () => {
    render(<BudgetSummary rows={[]} currencyCode="SGD" walletCount={2} />);
    expect(screen.getByText(/no budgets cover every wallet/i)).toBeInTheDocument();
    // No heading, no bar, no section chrome -- same "single line, nothing
    // else" precedent CategoryBreakdown/CashFlow's own empty states set.
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(document.querySelector(".h-2")).not.toBeInTheDocument();
  });
});
