import { formatMoney } from "@/lib/money";
import { budgetProgress, scopeLabel, type BudgetStatusRow } from "@/lib/budget-status";

/**
 * Stand-in for the category half of the pinned "<category label> · <scope
 * label>" heading format on the overall-cap row, whose own `category_label`
 * is NULL (controller addendum §1/§4). Deliberately the same string
 * `/budgets`' own `BudgetList.tsx` uses (`OVERALL_LABEL`) -- but NOT
 * imported from there: that file is `"use client"`, and a Server Component
 * importing a VALUE from a client module gets `undefined` silently at
 * runtime rather than an error (this task's brief calls that out by name as
 * the bug that shipped on the previous branch). A plain string constant has
 * no such import hazard.
 */
const OVERALL_LABEL = "Overall budget";

/**
 * Dashboard's all-wallets budget block (task-7-brief.md + its CONTROLLER
 * ADDENDUM). Placed after the cash-flow block on `(app)/page.tsx`.
 *
 * Only budgets whose wallet set covers EVERY active wallet in `currencyCode`
 * belong here (addendum §2) -- a budget over a SUBSET of wallets is a
 * `/budgets`-only concern; showing it beside the dashboard's hero total
 * (which spans every primary-currency wallet) would put two figures with
 * different scopes next to each other with nothing explaining the
 * difference. "Covers everything" is decided by calling `scopeLabel` --
 * the exact function `/budgets` uses for the same question -- rather than
 * re-deriving the `wallet_count === walletCount` comparison a second,
 * possibly-drifting way.
 *
 * Currency is filtered too: `get_budget_status` has no `wallet_ids`
 * parameter (it is scoped by RLS over every budget the caller can see,
 * across every currency), while this block sits beside a hero total that is
 * ALREADY scoped to one currency (`page.tsx`'s own `currency`/`walletIds`
 * resolution) -- see that file's doc comment on `hasExcludedWallets` for why
 * a non-primary-currency figure can't just be folded in silently.
 *
 * No SUM is ever taken across rows here (addendum §1): each row renders its
 * own `spent_minor`/`budget_minor` pair via `budgetProgress`, never a
 * `reduce` over the array -- the same money can legitimately appear both
 * inside a cap's `spent_minor` and again as a separate uncovered-spending
 * row (which this block excludes entirely, since it never has a
 * `budget_id`), so summing rows here would double count.
 */
export function BudgetSummary({
  rows,
  /** The primary currency `page.tsx` already resolved (the first-created
   *  active wallet's) -- this block reuses it rather than resolving its
   *  own, so it never disagrees with the hero figure above it. */
  currencyCode,
  /** Count of the caller's ACTIVE wallets in `currencyCode` -- `page.tsx`'s
   *  own `walletIds.length`, the same number every other figure on this
   *  page is already scoped to. Passed in rather than re-queried here, for
   *  the same "one source of truth" reason `page.tsx`'s own `spent` doc
   *  comment gives. */
  walletCount,
}: {
  rows: BudgetStatusRow[];
  currencyCode: string;
  walletCount: number;
}) {
  const allWalletRows = rows.filter((r) => {
    // An uncovered-spending row (controller addendum §4: `budget_id`,
    // `wallet_names`, `wallet_count`, `budget_minor`, `budget_period_start`
    // ALL null) never belongs on a budget-utilisation block -- there is no
    // budget to report progress against, and its `wallet_count` being null
    // must never be mistaken for "matches by coincidence."
    if (r.budget_id === null) return false;
    if (r.currency_code !== currencyCode) return false;
    return scopeLabel(r.wallet_names, r.wallet_count, walletCount) === "All wallets";
  });

  if (allWalletRows.length === 0) {
    // Same "single explanatory line, no heading, no empty chrome" precedent
    // `CategoryBreakdown`'s and `CashFlow`'s own empty states already set on
    // this page -- a fourth block that renders nothing when there are no
    // all-wallets budgets is worse than one that says why (addendum §6).
    return (
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        No budgets cover every wallet yet.
      </p>
    );
  }

  return (
    <section aria-labelledby="budget-heading" className="flex flex-col gap-4">
      <h2
        id="budget-heading"
        className="text-sm font-medium uppercase tracking-wide"
        style={{ color: "var(--ink-2)" }}
      >
        Budgets
      </h2>
      {allWalletRows.map((row) => (
        <BudgetSummaryRow key={row.budget_id!} row={row} />
      ))}
    </section>
  );
}

function BudgetSummaryRow({ row }: { row: BudgetStatusRow }) {
  const label = row.category_label ?? OVERALL_LABEL;
  const progress = budgetProgress(row);

  // A row that reaches here always has `budget_id !== null` (the caller's
  // own filter) -- per the row-shape contract (addendum §4) that means
  // `budget_minor` is never null either. Guarded anyway rather than trusted
  // transitively through the filter, matching `BudgetList.tsx`'s identical
  // guard on its own budget rows.
  if (progress.budgetMinor === null) return null;

  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium" style={{ color: "var(--ink)" }}>
        {label}
      </h3>
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        {formatMoney(progress.spentMinor, row.currency_code)} of{" "}
        {formatMoney(progress.budgetMinor, row.currency_code)} · {progress.percent}%
      </p>
      {/* aria-hidden: the paragraphs above (and, when over budget, the "Over
          by" paragraph below) already carry every bit of meaning this bar
          draws -- a colour/length-only cue is exactly what the controller
          addendum's accessibility rules forbid as the ONLY way to perceive a
          state. No `role="progressbar"`, for the same reason. */}
      <div aria-hidden className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--grid)" }}>
        <div
          style={{
            width: `${Math.min(progress.percent ?? 0, 100)}%`,
            minWidth: "2px",
            height: "100%",
            background: progress.isOver ? "var(--neg)" : "var(--cat-1)",
          }}
        />
      </div>
      {progress.isOver && (
        <p className="text-sm font-medium" style={{ color: "var(--neg)" }}>
          Over by {formatMoney(progress.spentMinor - progress.budgetMinor, row.currency_code)}
        </p>
      )}
    </div>
  );
}
