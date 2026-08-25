import type { BudgetStatusRow } from "@/lib/budget-status";

/**
 * Stable key for one `get_budget_status` row: `wallet_id` plus
 * `category_id` (or the literal "overall" for the wallet-wide cap, since
 * `category_id` is NULL for that row and NULL can't be used as an
 * object-key fragment). Used both as BudgetList.tsx's React `key` for a
 * row and, in page.tsx, to look up that row's real `budgets.id` in the
 * `budgetIds` map — see page.tsx's own doc comment for why that lookup
 * exists at all rather than `id` simply being a field on `BudgetStatusRow`.
 *
 * A plain, non-"use client" module deliberately: BudgetList.tsx is a
 * Client Component, and page.tsx (a Server Component) needs this exact
 * same function. Next 16 does not allow a Server Component to call a
 * plain function exported from a "use client" file directly — every
 * export of such a file is treated as a client reference, not a callable
 * server-side value ("Attempted to call budgetRowKey() from the server
 * but budgetRowKey is on the client" — caught by this task's own e2e
 * verification, not by any unit test, since BudgetList.test.tsx never
 * renders through a Server Component boundary). Pulling the pure function
 * out to its own ordinary module is what makes it callable from both.
 */
export function budgetRowKey(row: Pick<BudgetStatusRow, "wallet_id" | "category_id">): string {
  return `${row.wallet_id}::${row.category_id ?? "overall"}`;
}
