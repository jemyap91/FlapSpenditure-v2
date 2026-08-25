import { describe, expect, it } from "vitest";
import { budgetProgress } from "./budget-status";

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
});
