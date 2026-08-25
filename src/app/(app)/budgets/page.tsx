import { createClient } from "@/lib/supabase/server";
import { monthRange } from "@/lib/month-range";
import { BudgetList } from "./BudgetList";
import { MONTH_NAME } from "@/lib/month-names";
import type { BudgetStatusRow } from "@/lib/budget-status";

/**
 * /budgets — this month's spending against each wallet's overall cap and
 * per-category budgets (spec; migration 0012). Follows the same Server
 * Component fetch + Client Component interactivity split as
 * (app)/wallets/page.tsx (WalletList/MembersSection) and
 * (app)/categories/page.tsx (CategorySection): the query lives here, the
 * amount form, Save and Remove controls live in BudgetList.tsx.
 *
 * ONE read. An earlier version of this file also read `budgets` directly
 * to resolve each row's underlying id for `removeBudget(id)`, reasoning
 * that `get_budget_status`'s aggregate "could not cleanly" expose it. That
 * reasoning was wrong: 0012 was unpushed, so `get_budget_status` itself now
 * projects `budget_id`/`budget_period_start` straight out of the `eff` CTE
 * it already computes (the same "most recent period_start at or before the
 * queried month" resolution this page used to re-derive in JS from a
 * second, unbounded read of every budget row ever created). One source of
 * truth in one place beats the same rule written twice.
 */
export default async function BudgetsPage() {
  const supabase = await createClient();
  const { from, to } = monthRange();

  const { data, error } = await supabase.rpc("get_budget_status", { from_date: from, to_date: to });

  // A query error is not "no budgets" — data is null either way, so
  // rendering an empty state here would present a transient failure as
  // "you have nothing budgeted". Thrown, matching every other Server
  // Component here.
  if (error) throw new Error("Failed to load budgets");

  // Derived from `from` (the exact window just queried) by string slicing,
  // never a second, independent `new Date()` — an earlier task spent a
  // whole fix round unifying exactly this bug class (see month-range.ts's
  // own doc comment: a request straddling local midnight could otherwise
  // label a window it did not query). `from` is always "YYYY-MM-01"
  // (monthRange()), so index 5-6 is the month and 0-3 is the year; reuses
  // the shared month-names module -- a PLAIN module, not BudgetList, because
  // indexing a const imported across the "use client" boundary silently
  // yields undefined in the RSC layer (see src/lib/month-names.ts).
  const monthLabel = `${MONTH_NAME[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-1 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Budgets
      </h1>
      <p className="mb-6 text-sm" style={{ color: "var(--ink-2)" }}>
        {monthLabel} · expenses only
      </p>
      <BudgetList rows={(data ?? []) as BudgetStatusRow[]} currentPeriodStart={from} />
    </div>
  );
}
