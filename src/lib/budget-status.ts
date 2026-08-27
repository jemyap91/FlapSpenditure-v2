import type { Database } from "@/lib/database.types";

/**
 * `get_budget_status`'s (0013) generated row type, narrowed to reflect
 * nullability its `returns table(...)` signature actually has but
 * Supabase's codegen cannot express. `returns table` columns are typed
 * from the declared column type alone (e.g. `budget_id uuid`), with no way
 * to see that a specific SELECT branch inside the function body emits NULL
 * for it -- the same class of gap `set_budget`'s `p_category_key` argument
 * has (src/server/actions/budgets.ts), just on the return side instead of
 * the argument side.
 *
 * Concretely, the function's own SQL (0013_wallet_set_budgets.sql, final
 * `select ... union all select ...`) is NULL for:
 * - `budget_id`, `wallet_names`, `wallet_count`, `budget_minor`,
 *   `budget_period_start` -- the UNCOVERED-spending branch (`union all`'s
 *   second arm: `null::uuid, ..., null::text[], null::int, ..., null::bigint,
 *   null::date`), which reports spending in a category no visible budget
 *   covers for that wallet. There is no budget row backing it, so nothing
 *   about the budget -- its id, its wallet set, its amount, or the period it
 *   was set in -- exists to report.
 * - `category_key`, `category_label` -- the OVERALL-CAP row (a budget with
 *   a NULL `category_key`, representing a wallet set's total cap rather
 *   than any one category). The main branch's `coalesce((select min(name)
 *   from categories where lower(btrim(name)) = e.category_key), ...)`
 *   can't resolve a label when the key itself is NULL, so both stay NULL
 *   together.
 *
 * Deliberately NOT a hand-edit of `database.types.ts` (generated file,
 * regenerated wholesale by `npm run db:types` -- a hand-edit there would
 * just be silently discarded on the next run).
 */
type GeneratedBudgetStatusRow = Database["public"]["Functions"]["get_budget_status"]["Returns"][number];
export type BudgetStatusRow = Omit<
  GeneratedBudgetStatusRow,
  | "budget_id"
  | "category_key"
  | "category_label"
  | "wallet_names"
  | "wallet_count"
  | "budget_minor"
  | "budget_period_start"
> & {
  budget_id: string | null;
  category_key: string | null;
  category_label: string | null;
  wallet_names: string[] | null;
  wallet_count: number | null;
  budget_minor: number | null;
  budget_period_start: string | null;
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

/**
 * How a budget's wallet set reads on screen. "All accounts" is claimed ONLY
 * when the set covers every wallet in that currency — a set is materialised
 * when the budget is created (spec §1), so a wallet created afterwards is not
 * covered, and calling that "All accounts" would state something false rather
 * than merely stale.
 *
 * Pure function of its three arguments -- deliberately does not reach for
 * the row so callers can pass whatever they already have on hand (e.g. a
 * currency-scoped wallet count computed once for a whole list).
 */
export function scopeLabel(
  names: string[] | null,
  count: number | null,
  totalInCurrency: number,
): string {
  if (!names || !count) return "";
  // Defensive only -- unreachable through the current SQL, where `names`
  // and `count` are always produced together and agree in length (D4,
  // whole-branch review). Guards the indexed reads below (`names[0]`,
  // `names[1]`) against rendering the literal string "undefined" if a
  // future caller ever passes a shorter `names` than its own `count`.
  if (names.length < count) return `${count} accounts`;
  if (count === totalInCurrency) return "All accounts";
  if (count === 1) return names[0]!;
  if (count === 2) return `${names[0]} + ${names[1]}`;
  return `${count} accounts`;
}
