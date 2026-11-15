import { formatMoney, minorUnitFor } from "@/lib/money";
import { budgetProgress, scopeLabel, type BudgetStatusRow } from "@/lib/budget-status";

/**
 * Stand-in for the category half of the pinned "<category label> · <scope
 * label>" heading format on the overall-cap row, whose own `category_label`
 * is NULL (controller addendum §1/§4). Deliberately the same string
 * `/budgets`' own `BudgetList.tsx` uses (`OVERALL_LABEL`) -- but NOT
 * imported from there: that file is `"use client"`, and a Server Component
 * importing a VALUE from a client module gets `undefined` silently at
 * runtime rather than an error. A plain string constant has no such hazard.
 */
const OVERALL_LABEL = "Overall budget";

/**
 * The budgets that belong on Home: those whose wallet set covers EVERY
 * active wallet in `currencyCode` (addendum §2). A budget over a SUBSET of
 * wallets is a `/budgets`-only concern; showing it beside Home's total
 * (which spans every primary-currency wallet) would put two figures with
 * different scopes side by side. "Covers everything" is decided by
 * `scopeLabel`, the exact function `/budgets` uses for the same question.
 *
 * Uncovered-spending rows (`budget_id` null) never belong: there is no
 * budget to report progress against, and a null `wallet_count` must never
 * be mistaken for "matches by coincidence".
 */
export function allWalletBudgets(
  rows: readonly BudgetStatusRow[],
  currencyCode: string,
  walletCount: number,
): BudgetStatusRow[] {
  return rows.filter(
    (r) =>
      r.budget_id !== null &&
      r.currency_code === currencyCode &&
      scopeLabel(r.wallet_names, r.wallet_count, walletCount) === "All wallets",
  );
}

/** The overall (no-category) budget covering every wallet, for Home's hero. */
export function overallBudget(
  rows: readonly BudgetStatusRow[],
  currencyCode: string,
  walletCount: number,
): BudgetStatusRow | null {
  return allWalletBudgets(rows, currencyCode, walletCount).find((r) => r.category_id === null) ?? null;
}

/** A whole-unit figure ("313") for the cramped caption under a ring. */
function shortAmount(minor: number, currencyCode: string): string {
  const major = minor / 10 ** minorUnitFor(currencyCode);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(major);
}

/**
 * Home's budgets, as rings (Cherry Cola: budgets fold into Home, so the
 * Budgets tab can go). Each ring is drawn AND stated: the ring and its
 * short caption are aria-hidden, and a visually hidden sentence carries
 * "SGD 412.00 of SGD 600.00 · 69%" to a screen reader. An overrun turns the
 * ring cherry and is also said in words, in its own paragraph.
 *
 * No SUM is ever taken across rows (addendum §1): the same money can sit
 * inside a cap's `spent_minor` and again in a category row.
 */
export function BudgetSummary({
  rows,
  /** The primary currency `page.tsx` already resolved -- reused rather than
   *  re-resolved, so it never disagrees with the total above it. */
  currencyCode,
  /** Count of the caller's ACTIVE wallets in `currencyCode` (`page.tsx`'s
   *  own `walletIds.length`). */
  walletCount,
  /** Leave out the overall budget, because Home's hero already shows it. */
  hideOverall = false,
}: {
  rows: BudgetStatusRow[];
  currencyCode: string;
  walletCount: number;
  hideOverall?: boolean;
}) {
  const covering = allWalletBudgets(rows, currencyCode, walletCount);
  const shown = covering.filter((r) => !(hideOverall && r.category_id === null));

  if (shown.length === 0) {
    // A single explanatory line, no heading, no empty chrome (addendum §6).
    return (
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        {covering.length > 0
          ? "No category budgets cover every wallet yet."
          : "No budgets cover every wallet yet."}
      </p>
    );
  }

  return (
    <section aria-labelledby="budget-heading" className="flex flex-col gap-3">
      <h2 id="budget-heading" className="font-display text-base font-bold" style={{ color: "var(--ink)" }}>
        Budgets
      </h2>
      <ul
        className="grid grid-cols-3 gap-x-2 gap-y-4 rounded-3xl p-4 sm:grid-cols-4"
        style={{ background: "var(--surface)" }}
      >
        {shown.map((row) => (
          <BudgetRing key={row.budget_id!} row={row} />
        ))}
      </ul>
    </section>
  );
}

const RADIUS = 22;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function BudgetRing({ row }: { row: BudgetStatusRow }) {
  const label = row.category_label ?? OVERALL_LABEL;
  const progress = budgetProgress(row);
  // Always non-null for a budgeted row (addendum §4); guarded anyway.
  if (progress.budgetMinor === null || progress.percent === null) return null;

  const fraction = Math.min(progress.spentMinor / progress.budgetMinor, 1);

  return (
    <li className="flex flex-col items-center gap-1 text-center">
      <svg aria-hidden data-ring width="60" height="60" viewBox="0 0 60 60" className="block">
        <circle cx="30" cy="30" r={RADIUS} fill="none" stroke="var(--grid)" strokeWidth="7" />
        <circle
          cx="30"
          cy="30"
          r={RADIUS}
          fill="none"
          stroke={progress.isOver ? "var(--cherry)" : "var(--accent)"}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          transform="rotate(-90 30 30)"
        />
        <text
          x="30"
          y="34"
          textAnchor="middle"
          fontSize="12"
          fontWeight="800"
          fill={progress.isOver ? "var(--neg)" : "var(--ink)"}
        >
          {progress.percent}%
        </text>
      </svg>
      <h3 className="text-xs font-extrabold" style={{ color: "var(--ink)" }}>
        {label}
      </h3>
      <p aria-hidden className="text-[11px] font-semibold" style={{ color: "var(--ink-2)" }}>
        {shortAmount(progress.spentMinor, row.currency_code)} / {shortAmount(progress.budgetMinor, row.currency_code)}
      </p>
      <p className="sr-only">
        {formatMoney(progress.spentMinor, row.currency_code)} of{" "}
        {formatMoney(progress.budgetMinor, row.currency_code)} · {progress.percent}%
      </p>
      {progress.isOver && (
        <p className="text-[11px] font-extrabold" style={{ color: "var(--neg)" }}>
          Over by {formatMoney(progress.spentMinor - progress.budgetMinor, row.currency_code)}
        </p>
      )}
    </li>
  );
}
