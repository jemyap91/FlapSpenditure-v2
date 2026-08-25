/** The subset of `get_budget_status`'s row this derivation needs. */
export type BudgetRow = { spent_minor: number; budget_minor: number | null };

/**
 * Progress of one budget row. Pure — no I/O, no formatting, no currency.
 *
 * `budget_minor` is NULL for a category that has spending but no budget.
 * That is NOT zero: zero would make every unbudgeted category render as
 * infinitely over. Such a row is "untracked" — percent and remaining are
 * null, and it is never over.
 *
 * A non-positive `budget_minor` (zero or negative) is treated the same way
 * — untracked, not a division by zero or a negative-budget overrun. The DB
 * CHECK constraint (`amount_minor > 0` on `budgets`) makes this unreachable
 * through the real schema, but this function is pure and publicly callable,
 * so it must not produce `Infinity`/`NaN`/nonsense for an out-of-range
 * input instead of failing safely.
 */
export function budgetProgress(row: BudgetRow): {
  spentMinor: number;
  budgetMinor: number | null;
  percent: number | null;
  remainingMinor: number | null;
  isOver: boolean;
} {
  const { spent_minor: spentMinor, budget_minor: budgetMinor } = row;
  if (budgetMinor === null || budgetMinor <= 0) {
    return { spentMinor, budgetMinor: null, percent: null, remainingMinor: null, isOver: false };
  }
  return {
    spentMinor,
    budgetMinor,
    percent: Math.round((spentMinor / budgetMinor) * 100),
    remainingMinor: budgetMinor - spentMinor,
    // Strictly greater: spending exactly the budget is 100%, not an overrun.
    isOver: spentMinor > budgetMinor,
  };
}
