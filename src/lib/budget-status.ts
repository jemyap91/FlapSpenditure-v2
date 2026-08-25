import type { Database } from "@/lib/database.types";

/**
 * `get_budget_status`'s (0012) generated row type, narrowed to reflect
 * nullability its `returns table(...)` signature actually has but
 * Supabase's codegen cannot express. `returns table` columns are typed
 * from the declared column type alone (e.g. `category_id uuid`), with no
 * way to see that a specific SELECT branch inside the function body emits
 * NULL for it -- the same class of gap `set_budget`'s `p_category_id`
 * argument has (src/server/actions/budgets.ts), just on the return side
 * instead of the argument side.
 *
 * Concretely, the function's own SQL (0012_budgets.sql) is NULL for:
 * - `category_id`, `category_name`, `color_slot`, `icon` -- the overall-cap
 *   row (`null::uuid, null::text, null::smallint, null::text`), which
 *   represents the wallet's total cap rather than any one category.
 * - `budget_minor` -- any row for a category (or the overall cap) that has
 *   spending but no budget set for it: "no budget" is NULL, deliberately
 *   never 0, so it stays distinguishable from a budget of zero (which the
 *   `amount_minor > 0` CHECK on `budgets` makes impossible anyway).
 *
 * Deliberately NOT a hand-edit of `database.types.ts` (generated file,
 * regenerated wholesale by `npm run db:types` -- a hand-edit there would
 * just be silently discarded on the next run). This narrowing type is
 * unused until the /budgets UI (a later task) imports it; that is
 * intended, not dead code.
 */
type GeneratedBudgetStatusRow = Database["public"]["Functions"]["get_budget_status"]["Returns"][number];
export type BudgetStatusRow = Omit<
  GeneratedBudgetStatusRow,
  "category_id" | "category_name" | "color_slot" | "icon" | "budget_minor"
> & {
  category_id: string | null;
  category_name: string | null;
  color_slot: number | null;
  icon: string | null;
  budget_minor: number | null;
};

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
