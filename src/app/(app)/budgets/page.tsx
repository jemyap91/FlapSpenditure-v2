import { createClient } from "@/lib/supabase/server";
import { monthRange } from "@/lib/month-range";
import { BudgetList } from "./BudgetList";
import { budgetRowKey } from "./budget-row-key";
import type { BudgetStatusRow } from "@/lib/budget-status";

/**
 * /budgets — this month's spending against each wallet's overall cap and
 * per-category budgets (spec; migration 0012). Follows the same Server
 * Component fetch + Client Component interactivity split as
 * (app)/wallets/page.tsx (WalletList/MembersSection) and
 * (app)/categories/page.tsx (CategorySection): the queries live here, the
 * amount form, Save and Remove controls live in BudgetList.tsx.
 *
 * TWO reads, not one, and the second is not in the Task 5 brief's own
 * page.tsx sketch — added to close a real gap between what Task 2's
 * `get_budget_status` returns and what Task 4's `removeBudget` needs. See
 * `budgetIds` below.
 */
export default async function BudgetsPage() {
  const supabase = await createClient();
  const { from, to } = monthRange();

  const [{ data, error }, { data: budgetsRaw, error: budgetsError }] = await Promise.all([
    supabase.rpc("get_budget_status", { from_date: from, to_date: to }),
    // Plain select on `budgets` itself, RLS-scoped by `budgets_member`
    // (is_wallet_member) the same way every other read on this screen is.
    // `get_budget_status` aggregates spend against the wallet's currently
    // EFFECTIVE budget but does not — and structurally cannot cleanly —
    // return that budget row's own `id` (a category can appear in its
    // result from spending alone, with no budget row at all). `removeBudget`
    // (src/server/actions/budgets.ts) deletes by that id, so this read
    // supplies it: every row `get_budget_status` could possibly attribute a
    // NON-NULL `budget_minor` to. `budgetIds` below resolves the same
    // "most recent period_start at or before this month" rule the SQL's own
    // `eff` CTE (0012_budgets.sql) applies, from this raw list.
    supabase.from("budgets").select("id, wallet_id, category_id, period_start"),
  ]);

  // A query error is not "no budgets" — data is null for both, so rendering
  // an empty state here would present a transient failure as "you have
  // nothing budgeted". Thrown, matching every other Server Component here.
  if (error) throw new Error("Failed to load budgets");
  if (budgetsError) throw new Error("Failed to load budgets");

  // Effective budget id per (wallet_id, category_id): the row with the
  // latest `period_start` at or before this month's first day, mirroring
  // `get_budget_status`'s own `eff` CTE (`distinct on (wallet_id,
  // category_id) ... where period_start <= from_date order by period_start
  // desc`). A plain JS reduction rather than a second RPC: the rule is
  // small enough to restate here, and adding a THIRD database round trip
  // for it would be pure overhead.
  const budgetIds: Record<string, string> = {};
  const latestPeriodStart: Record<string, string> = {};
  for (const b of budgetsRaw ?? []) {
    if (b.period_start > from) continue;
    const key = budgetRowKey({ wallet_id: b.wallet_id, category_id: b.category_id });
    const current = latestPeriodStart[key];
    if (current === undefined || b.period_start > current) {
      latestPeriodStart[key] = b.period_start;
      budgetIds[key] = b.id;
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-1 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Budgets
      </h1>
      <p className="mb-6 text-sm" style={{ color: "var(--ink-2)" }}>
        {new Date().toLocaleString("en-US", { month: "long", year: "numeric" })} · expenses only
      </p>
      <BudgetList rows={(data ?? []) as BudgetStatusRow[]} budgetIds={budgetIds} />
    </div>
  );
}
