"use client";

import { useId, useState, useTransition, useActionState } from "react";
import { setBudget, removeBudget, type BudgetState } from "@/server/actions/budgets";
import { formatMoney } from "@/lib/money";
import { budgetProgress, type BudgetStatusRow } from "@/lib/budget-status";
import { MONTH_ABBREV } from "@/lib/month-names";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * `Aug` for a budget set in the current calendar year, `Aug 2025` for one
 * set in an earlier year — `currentPeriodStart` (this month's own
 * "YYYY-MM-01") is what "current year" means here, not the viewer's clock,
 * for the same one-source-of-truth reason `BudgetList`'s own doc comment
 * gives for threading it down at all. Month-only was wrong on its own
 * (fix round 2, item 2): a budget set August 2025 and still in force in
 * November 2026 rendered `Remove (set Aug)`, which reads as August THIS
 * year — a disclosure that states a falsehood is worse than the silence it
 * replaced. Still pure string slicing, never `new Date(...)`, for the
 * identical timezone reason as the month-only version this replaces.
 */
function monthAbbrev(periodStart: string, currentPeriodStart: string): string {
  const month = Number(periodStart.slice(5, 7));
  const abbrev = MONTH_ABBREV[month - 1] ?? periodStart;
  const year = periodStart.slice(0, 4);
  const currentYear = currentPeriodStart.slice(0, 4);
  return year === currentYear ? abbrev : `${abbrev} ${year}`;
}

/**
 * Rows grouped by wallet, in first-seen order, with the overall cap
 * (`category_id === null`) sorted first within each group, followed by
 * every category row — spec §5: "The wallet's overall cap, then each
 * budgeted category, then any unbudgeted category that has spending this
 * month."
 *
 * `get_budget_status` (0012_budgets.sql) has no `ORDER BY` at all, unlike
 * `get_category_breakdown` (`order by 5 desc`), so relying on whatever
 * order Postgres happens to hand back is heap order — a `VACUUM` can
 * reshuffle it between two loads of the same page. The category half of
 * the spec's order (budgeted before unbudgeted, alphabetical within each)
 * is therefore enforced here in TypeScript rather than left to chance.
 */
function groupByWallet(
  rows: readonly BudgetStatusRow[],
): { walletId: string; walletName: string; rows: BudgetStatusRow[] }[] {
  const order: string[] = [];
  const byWallet = new Map<string, { walletName: string; rows: BudgetStatusRow[] }>();
  for (const row of rows) {
    if (!byWallet.has(row.wallet_id)) {
      order.push(row.wallet_id);
      byWallet.set(row.wallet_id, { walletName: row.wallet_name, rows: [] });
    }
    byWallet.get(row.wallet_id)!.rows.push(row);
  }
  return order.map((walletId) => {
    const group = byWallet.get(walletId)!;
    const overall = group.rows.filter((r) => r.category_id === null);
    const categories = group.rows
      .filter((r) => r.category_id !== null)
      .sort(
        (a, b) =>
          Number(b.budget_minor !== null) - Number(a.budget_minor !== null) ||
          (a.category_name ?? "").localeCompare(b.category_name ?? ""),
      );
    return { walletId, walletName: group.walletName, rows: [...overall, ...categories] };
  });
}

/**
 * The /budgets screen's interactive body. A Client Component (page.tsx does
 * the Server Component data-fetching and hands `rows` down), matching the
 * split CategorySection.tsx and MembersSection.tsx both use.
 */
export function BudgetList({
  rows,
  currentPeriodStart,
}: {
  rows: BudgetStatusRow[];
  /**
   * This month's `period_start` (`monthRange().from` — page.tsx computes it
   * once and passes the same string down, rather than this component
   * calling `monthRange()` itself a second time and risking it disagreeing
   * with the value the page already queried `get_budget_status` with).
   * Optional: the pinned component test (BudgetList.test.tsx) never passes
   * it, and with no reference to compare against there is nothing honest
   * to disclose, so every row is rendered as if it were the current
   * month's own — never a FALSE "set in the past" claim, only a possibly
   * missing true one.
   */
  currentPeriodStart?: string;
}) {
  const groups = groupByWallet(rows);

  if (groups.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        No spending or budgets recorded this month.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <section key={group.walletId} aria-labelledby={`budget-wallet-heading-${group.walletId}`}>
          <h2
            id={`budget-wallet-heading-${group.walletId}`}
            className="mb-3 text-lg font-semibold"
            style={{ color: "var(--ink)" }}
          >
            {group.walletName}
          </h2>
          <ul className="flex flex-col gap-3">
            {group.rows.map((row) => (
              <BudgetRow
                key={`${row.wallet_id}::${row.category_id ?? "overall"}`}
                row={row}
                currentPeriodStart={currentPeriodStart}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function BudgetRow({
  row,
  currentPeriodStart,
}: {
  row: BudgetStatusRow;
  currentPeriodStart?: string;
}) {
  const isOverall = row.category_id === null;
  const label = isOverall ? "All spending" : (row.category_name ?? "Category");
  const progress = budgetProgress(row);
  const amountStatusId = useId();

  const [formState, formAction, saving] = useActionState<BudgetState, FormData>(
    setBudget.bind(null, row.wallet_id, row.category_id),
    {},
  );

  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, startRemoving] = useTransition();

  function handleRemove() {
    if (!row.budget_id) return;
    setRemoveError(null);
    startRemoving(async () => {
      const res = await removeBudget(row.budget_id!);
      if (res.error) setRemoveError(res.error);
    });
  }

  const removeLabel = isOverall ? "Remove overall budget" : `Remove budget for ${label}`;

  // Disclosure, not a confirmation dialog (agreed fix round scope): a
  // budget set in an EARLIER month and never touched since is still that
  // earlier month's own row (spec: "the effective budget for a month is
  // the most recent row at or before it"). Clicking Remove here hard-
  // deletes that row, retroactively un-budgeting every month it was
  // carried forward into — with no undo. The `aria-label` above stays the
  // pinned, byte-identical string either way; only the VISIBLE button text
  // gains the qualifier, so a sighted user sees it without changing what a
  // screen-reader user is told the control is named.
  const isPastBudget =
    row.budget_period_start !== null &&
    currentPeriodStart !== undefined &&
    row.budget_period_start !== currentPeriodStart;
  const removeButtonText = removing
    ? "Removing…"
    : isPastBudget
      ? `Remove (set ${monthAbbrev(row.budget_period_start!, currentPeriodStart!)})`
      : "Remove";

  return (
    <li
      className="flex flex-col gap-2 rounded-lg border p-3"
      style={{ borderColor: "var(--grid)", background: "var(--surface)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium" style={{ color: "var(--ink)" }}>
          {label}
        </span>
        {row.budget_id && (
          <button
            type="button"
            aria-label={removeLabel}
            disabled={removing}
            onClick={handleRemove}
            className={`shrink-0 text-xs underline disabled:opacity-60 ${FOCUS_RING}`}
            style={{ color: "var(--ink-2)" }}
          >
            {removeButtonText}
          </button>
        )}
      </div>

      {progress.budgetMinor === null ? (
        // Secondary text: var(--ink-2), not var(--muted) — var(--muted)
        // measures 3.41:1 against var(--page)/var(--surface) and fails AA
        // for normal-size text (task-5-brief.md Step 3).
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          {formatMoney(progress.spentMinor, row.currency_code)} spent · No budget set
        </p>
      ) : (
        <>
          <p className="text-sm" style={{ color: "var(--ink-2)" }}>
            {formatMoney(progress.spentMinor, row.currency_code)} of{" "}
            {formatMoney(progress.budgetMinor, row.currency_code)} · {progress.percent}%
          </p>
          {/* aria-hidden: the paragraph above (and, when over budget, the
              "Over by" paragraph below) already carries every bit of
              meaning this bar draws — a colour/length-only cue is exactly
              what spec §5 (and this project's existing convention: see
              CategoryBreakdown.tsx and TransactionList's signed amounts)
              forbids as the ONLY way to perceive a state. */}
          <div
            aria-hidden
            className="h-2 w-full overflow-hidden rounded-full"
            style={{ background: "var(--grid)" }}
          >
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
        </>
      )}

      {/* Always mounted, not conditionally rendered — a role="alert" node
          that appears and gets its text in the same instant is not
          reliably announced (MembersSection.tsx's own reasoning).
          `aria-label` is per-ROW (derived from `label`, not a bare
          "Error"): this page renders one of these per row, unlike
          MembersSection's single instance for a whole section, so an
          unlabelled `role="alert"` would make every row's live region
          indistinguishable from every other's, both to `getByRole("alert")`
          and to a screen-reader user who has more than one open. */}
      <p role="alert" aria-label={`Error for ${label}`} className="text-sm" style={{ color: "var(--neg)" }}>
        {removeError}
      </p>

      <form action={formAction} className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Budget amount
          </span>
          <input
            type="text"
            inputMode="decimal"
            name="amount"
            autoComplete="off"
            placeholder="0.00"
            aria-describedby={formState.error ? amountStatusId : undefined}
            className={`rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
          />
        </label>
        <button
          type="submit"
          disabled={saving}
          className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
          style={{ background: "var(--cat-1)", color: "var(--surface)" }}
        >
          {saving ? "Saving…" : "Save budget"}
        </button>
      </form>
      {/* role="status", not role="alert": this row already has ONE
          always-mounted role="alert" above (the Remove error) — a second
          simultaneous role="alert" node makes getByRole("alert") ambiguous
          for anything that queries by role alone (MembersSection.tsx's own
          reasoning for the identical split). Per-row `aria-label` for the
          same reason the alert above has one. Doubles as the save NOTICE
          on success (`formState.notice`, e.g. "Budget saved.") so a save
          is announced rather than silent — coloured var(--neg) only when
          it is actually an error, matching MembersSection's identical
          error-vs-notice split for its own invite-result paragraph.

          The MESSAGE TEXT lives in a child <span id={amountStatusId}>,
          not on this <p> itself (fix round 2, item 1). An accessible
          DESCRIPTION is computed by running the text-alternative algorithm
          on the referenced node, and `aria-label` wins over name-from-
          content there — so the amount input's `aria-describedby` pointing
          at THIS <p> (which fix round 1 gave `aria-label="Status for
          ...\"`) resolved to "Status for Groceries", never the actual
          error text. CategorySection.tsx's identical-looking
          `aria-describedby` pattern works only because its own error
          paragraph carries no `aria-label` at all. Splitting the two jobs
          onto two nodes — the label for per-row disambiguation on the
          outer <p>, the describable text on an unlabelled inner <span> —
          means neither can spoil the other. */}
      <p
        role="status"
        aria-label={`Status for ${label}`}
        className="text-sm"
        style={{ color: formState.error ? "var(--neg)" : "var(--ink-2)" }}
      >
        <span id={amountStatusId}>{formState.error ?? formState.notice}</span>
      </p>
    </li>
  );
}
