"use client";

import { useState, useTransition, useActionState } from "react";
import { setBudget, removeBudget, type BudgetState } from "@/server/actions/budgets";
import { formatMoney } from "@/lib/money";
import { budgetProgress, type BudgetStatusRow } from "@/lib/budget-status";
import { budgetRowKey } from "./budget-row-key";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * Rows grouped by wallet, in first-seen order, with the overall cap
 * (`category_id === null`) sorted first within each group — spec: "the
 * overall cap first ... then each category" (task-5-brief.md Step 3).
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
    const categories = group.rows.filter((r) => r.category_id !== null);
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
  budgetIds = {},
}: {
  rows: BudgetStatusRow[];
  /**
   * `budgetRowKey(row) -> budgets.id`. `get_budget_status` (0012) does not
   * — and structurally cannot cleanly — return the underlying `budgets`
   * row's own id: it is an aggregate over `spend` and the WALLET's
   * currently-effective budget, not a select over `budgets` itself, and a
   * category can appear here from spending alone with no budget row at
   * all. `removeBudget` (src/server/actions/budgets.ts), however, deletes
   * by that exact id. `page.tsx` closes the gap with one extra read of
   * `budgets` itself (RLS-scoped the same way every other read here is)
   * and resolves each row's CURRENTLY EFFECTIVE budget id the same way the
   * SQL's own `eff` CTE does — most recent `period_start` at or before the
   * queried month. Optional, and defaulted to `{}`, so a caller that has
   * no budget rows yet (or, as here, a unit test that only cares about the
   * read-side rendering) never has to supply it: a row with no resolvable
   * id simply renders without a Remove control, rather than one that would
   * fail whenever clicked.
   */
  budgetIds?: Record<string, string>;
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
            {group.rows.map((row) => {
              const key = budgetRowKey(row);
              return <BudgetRow key={key} row={row} budgetId={budgetIds[key]} />;
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function BudgetRow({ row, budgetId }: { row: BudgetStatusRow; budgetId?: string }) {
  const isOverall = row.category_id === null;
  const label = isOverall ? "All spending" : (row.category_name ?? "Category");
  const progress = budgetProgress(row);

  const [formState, formAction, saving] = useActionState<BudgetState, FormData>(
    setBudget.bind(null, row.wallet_id, row.category_id),
    {},
  );

  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, startRemoving] = useTransition();

  function handleRemove() {
    if (!budgetId) return;
    setRemoveError(null);
    startRemoving(async () => {
      const res = await removeBudget(budgetId);
      if (res.error) setRemoveError(res.error);
    });
  }

  const removeLabel = isOverall ? "Remove overall budget" : `Remove budget for ${label}`;

  return (
    <li
      className="flex flex-col gap-2 rounded-lg border p-3"
      style={{ borderColor: "var(--grid)", background: "var(--surface)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium" style={{ color: "var(--ink)" }}>
          {label}
        </span>
        {budgetId && (
          <button
            type="button"
            aria-label={removeLabel}
            disabled={removing}
            onClick={handleRemove}
            className={`shrink-0 text-xs underline disabled:opacity-60 ${FOCUS_RING}`}
            style={{ color: "var(--ink-2)" }}
          >
            {removing ? "Removing…" : "Remove"}
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
          reliably announced (MembersSection.tsx's own reasoning). */}
      <p role="alert" className="text-sm" style={{ color: "var(--neg)" }}>
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
          reasoning for the identical split). */}
      <p role="status" className="text-sm" style={{ color: "var(--neg)" }}>
        {formState.error}
      </p>
    </li>
  );
}
