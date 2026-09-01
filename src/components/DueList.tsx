"use client";

import { useState, useTransition } from "react";
import { recordOccurrence, skipOccurrence } from "@/server/actions/recurring";
import { formatMoney } from "@/lib/money";
import type { DueRow } from "@/app/(app)/due-rows";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Reads a `YYYY-MM-DD` string's digits directly — never through
 *  `new Date(...)`. src/lib/month-range.ts documents a shipped Critical bug
 *  from mixing a local `Date` with a UTC read (or vice versa); the fields
 *  here come straight off the string itself, so there is no direction of
 *  conversion left to mismatch — same pattern RecurringList.tsx's own
 *  `parseIso` uses. */
function parseIso(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

/** "1 July" — no year. Every due occurrence this list can show falls
 *  within the trailing 12 months (`occurrencesFor`'s own lookback floor),
 *  so a bare day-and-month is unambiguous enough to read at a glance, and a
 *  queue meant to be cleared quickly doesn't need the extra noise of a year
 *  that's almost always the current one. */
function dueDateLabel(iso: string): string {
  const { m, d } = parseIso(iso);
  return `${d} ${MONTH_NAMES[m - 1]}`;
}

/**
 * The dashboard's DUE section (Task 6): every outstanding recurring
 * occurrence, oldest first, with per-row Record and Skip — the same
 * Server Component (page.tsx) + Client Component split, and the same
 * per-row-action-named-after-its-row reasoning, WalletList.tsx and
 * RecurringList.tsx already established. Here the reasoning is even more
 * load-bearing than usual: the SAME rule can appear on more than one row at
 * once (July's rent and August's rent both outstanding), so "Record" alone
 * would leave two buttons on the page with the identical accessible name —
 * the date is what actually distinguishes them, hence `Record ${ruleName}
 * for ${date}` rather than just `Record ${ruleName}`.
 *
 * `rows` is `buildDueRows`'s own output (`./src/app/(app)/due-rows.ts`) —
 * this component renders it and does nothing else; every decision about
 * WHICH occurrences are due, and why a given one is blocked, already
 * happened there.
 *
 * Renders nothing at all when `rows` is empty, per this task's brief: the
 * dashboard is opened many times a day and most of those times nothing is
 * owed, so there is no empty state here, not even a "you're all caught up"
 * card — unlike WalletList/RecurringList, which both render a sentence for
 * their own empty case.
 *
 * A blocked row (`row.blockedReason !== null`) renders that reason INSTEAD
 * of its Record/Skip buttons, never a button that would fail the instant it
 * was pressed — `recordOccurrence` re-validates the wallet, the currency
 * pairing, the category and the pause state server-side regardless, but a
 * button that always fails is worse than no button, and the reason is
 * already known at render time (`buildDueRows` computed it from the same
 * facts `recordOccurrence` would re-check). Skip is withheld too, even
 * though `skipOccurrence` itself carries none of those checks — kept
 * symmetric with Record rather than offering a half-populated row, at the
 * cost that a row blocked by an unarchivable wallet (this codebase has no
 * "restore" action for an archived wallet yet) currently has no way to
 * leave this list at all; see this task's report.
 */
export function DueList({ rows, olderDropped }: { rows: DueRow[]; olderDropped: boolean }) {
  const [error, setError] = useState<string | null>(null);
  /** Which row is mid-request, keyed by `ruleId:occurrenceOn` — a single
   *  value, not a per-row map, matching WalletList's/RecurringList's
   *  identical `pendingId` reasoning: only one request is ever "the one
   *  the user just triggered" from this list's own controls. */
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [, start] = useTransition();

  // Nothing due: render nothing, not an empty state — see this component's
  // own doc comment.
  if (rows.length === 0) return null;

  function run(row: DueRow, action: (ruleId: string, occurrenceOn: string) => Promise<{ error?: string }>) {
    setError(null);
    const key = `${row.ruleId}:${row.occurrenceOn}`;
    setPendingKey(key);
    start(async () => {
      // Both actions RETURN their error rather than throwing — same
      // reasoning as WalletList's `archive`/RecurringList's `pause`: a
      // thrown message reaches the browser as an opaque digest in
      // production.
      const res = await action(row.ruleId, row.occurrenceOn);
      if (res.error) setError(res.error);
      setPendingKey(null);
    });
  }

  return (
    <section aria-labelledby="due-heading" className="flex flex-col gap-2">
      <h2
        id="due-heading"
        className="text-sm font-medium uppercase tracking-wide"
        style={{ color: "var(--ink-2)" }}
      >
        Due
      </h2>

      {/* Always mounted, not conditionally rendered — see WalletList.tsx's
          identical paragraph for why a role="alert" that appears and gets
          its text in the same instant is not reliably announced. */}
      <p role="alert" className="text-sm" style={{ color: "var(--neg)" }}>
        {error}
      </p>

      <ul className="flex flex-col">
        {rows.map((row) => {
          const key = `${row.ruleId}:${row.occurrenceOn}`;
          const pending = pendingKey === key;
          const dateLabel = dueDateLabel(row.occurrenceOn);
          return (
            <li
              key={key}
              aria-label={`${row.ruleName}, ${dateLabel}`}
              className="mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 transition-opacity"
              style={{ borderColor: "var(--grid)", opacity: pending ? 0.5 : 1 }}
              aria-busy={pending || undefined}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate" style={{ color: "var(--ink)" }}>
                  {row.ruleName}
                </span>
                <span className="block text-xs" style={{ color: "var(--ink-2)" }}>
                  {dateLabel} · {row.walletName}
                </span>
              </span>
              <span
                className="shrink-0 tabular-nums"
                style={{ color: row.amountMinor < 0 ? "var(--neg)" : "var(--ink)" }}
              >
                {formatMoney(row.amountMinor, row.currencyCode, { signed: true })}
              </span>

              {row.blockedReason ? (
                <p className="shrink-0 max-w-[45%] text-right text-xs" style={{ color: "var(--neg)" }}>
                  {row.blockedReason}
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={`Record ${row.ruleName} for ${dateLabel}`}
                    onClick={() => run(row, recordOccurrence)}
                    className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
                    style={{ background: "var(--cat-1)", color: "var(--surface)" }}
                  >
                    Record
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={`Skip ${row.ruleName} for ${dateLabel}`}
                    onClick={() => run(row, skipOccurrence)}
                    className={`shrink-0 rounded-md border px-3 py-2 text-sm disabled:opacity-60 ${FOCUS_RING}`}
                    style={{ borderColor: "var(--ink-2)", color: "var(--ink-2)" }}
                  >
                    Skip
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {/* States the backstop explicitly rather than letting a truncated
          list read as "you are up to date" — `occurrencesFor`'s own doc
          comment on `olderDropped` says exactly this, and this task's
          brief repeats it for this list specifically. */}
      {olderDropped && (
        <p className="text-xs" style={{ color: "var(--ink-2)" }}>
          Some older occurrences (more than 12 months back) aren’t shown here.
        </p>
      )}
    </section>
  );
}
