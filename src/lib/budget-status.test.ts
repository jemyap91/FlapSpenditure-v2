import { describe, expect, it } from "vitest";
import { budgetProgress, scopeLabel } from "./budget-status";

const row = (spent: number, budget: number | null) => ({
  spent_minor: spent,
  budget_minor: budget,
});

describe("budgetProgress", () => {
  it("reports percent and remaining against the budget", () => {
    const p = budgetProgress(row(41200, 60000));
    expect(p.percent).toBe(69);
    expect(p.remainingMinor).toBe(18800);
    expect(p.isOver).toBe(false);
  });

  it("flags an overrun and reports the overspend as a positive number", () => {
    const p = budgetProgress(row(24500, 20000));
    expect(p.isOver).toBe(true);
    expect(p.percent).toBe(123);
    expect(p.remainingMinor).toBe(-4500);
  });

  it("treats a missing budget as untracked, NOT as an instant overrun", () => {
    // budget_minor is NULL for a category with spending but no budget. Zero
    // would make every unbudgeted category render as infinitely over.
    const p = budgetProgress(row(9000, null));
    expect(p.percent).toBeNull();
    expect(p.remainingMinor).toBeNull();
    expect(p.isOver).toBe(false);
  });

  it("is exactly at 100 percent, not over, when spending equals the budget", () => {
    const p = budgetProgress(row(50000, 50000));
    expect(p.percent).toBe(100);
    expect(p.isOver).toBe(false);
  });

  it("reports zero percent for a budget with no spending yet", () => {
    expect(budgetProgress(row(0, 30000)).percent).toBe(0);
  });

  it("treats a non-positive budget as untracked, not a division by zero", () => {
    // Unreachable through the real schema (the `budgets` CHECK requires
    // amount_minor > 0), but budgetProgress is pure and public, so a zero or
    // negative budget must not produce Infinity/NaN — it degrades to
    // "untracked" the same as a NULL budget.
    const zero = budgetProgress(row(9000, 0));
    expect(zero.percent).toBeNull();
    expect(zero.remainingMinor).toBeNull();
    expect(zero.isOver).toBe(false);

    const negative = budgetProgress(row(9000, -100));
    expect(negative.percent).toBeNull();
    expect(negative.remainingMinor).toBeNull();
    expect(negative.isOver).toBe(false);
  });
});

describe("scopeLabel", () => {
  it("names a single account outright", () => {
    expect(scopeLabel(["Everyday"], 1, 3)).toBe("Everyday");
  });

  it("joins two accounts, because the names still fit", () => {
    expect(scopeLabel(["Everyday", "Savings"], 2, 3)).toBe("Everyday + Savings");
  });

  it("counts beyond two rather than listing them", () => {
    expect(scopeLabel(["A", "B", "C"], 3, 5)).toBe("3 accounts");
  });

  it("says All accounts only when it really covers all of them", () => {
    expect(scopeLabel(["A", "B", "C"], 3, 3)).toBe("All accounts");
  });

  it("does NOT say All accounts once a new account exists outside it", () => {
    // The set is materialised at creation (spec §1), so a wallet added later
    // is not covered. Claiming "All accounts" here would be a false statement,
    // not merely a stale one.
    expect(scopeLabel(["A", "B", "C"], 3, 4)).toBe("3 accounts");
  });

  it("falls back for an unbudgeted row, which has no scope", () => {
    expect(scopeLabel(null, null, 3)).toBe("");
  });
});
