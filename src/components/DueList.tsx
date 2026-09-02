"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { recordOccurrence, skipOccurrence, unskipOccurrence } from "@/server/actions/recurring";
import { formatMoney } from "@/lib/money";
import { shortDate } from "@/app/(app)/recurring/RecurringList";
import type { DueRow } from "@/app/(app)/due-rows";
import { UndoToast, type ToastState } from "./UndoToast";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * A row's date, WITH its year whenever that year isn't `today`'s — fix
 * round 1, I2 (blocking). The 12-month lookback window is INCLUSIVE at both
 * ends, so a monthly rule anchored exactly a year back offers 13
 * occurrences and a yearly rule offers 2, and the first/last of either pair
 * fall on the same day-and-month in two different calendar years: without
 * the year, both rendered "1 September", both Record buttons got the
 * identical accessible name, and RTL's `getByRole` would throw on the
 * duplicate (this file's own tests hit exactly that before this fix).
 *
 * Consolidated on `RecurringList.tsx`'s own `shortDate(iso, withYear)`
 * rather than keeping a second, independently-abbreviated date formatter
 * here — this file previously had its own `parseIso` and a `MONTH_NAMES`
 * spelling out full month names ("1 July") where `RecurringList.tsx`
 * abbreviates ("1 Jul"); two formatters for the same concept in one PR was
 * exactly the kind of drift `src/lib/today.ts`'s own extraction (this same
 * commit) exists to avoid elsewhere.
 *
 * Plain string comparison of the leading 4 characters, never a `Date` —
 * this codebase's standing rule for `YYYY-MM-DD` strings (see
 * `src/lib/today.ts`, `src/lib/month-range.ts`).
 */
function dueDateLabel(occurrenceOn: string, today: string): string {
  return shortDate(occurrenceOn, occurrenceOn.slice(0, 4) !== today.slice(0, 4));
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
 * happened there. `today` is the SAME calendar date `page.tsx` already
 * computed to build those rows, threaded down only so this component can
 * decide whether a row's year needs stating (see `dueDateLabel`) — never
 * re-derived from the browser's own clock, which would let this component
 * disagree with the server about what day it is (the exact bug class
 * `src/lib/today.ts` exists to prevent).
 *
 * Renders nothing at all when `rows` is empty, per this task's brief: the
 * dashboard is opened many times a day and most of those times nothing is
 * owed, so there is no empty state here, not even a "you're all caught up"
 * card — unlike WalletList/RecurringList, which both render a sentence for
 * their own empty case. Spec §5's link to `/recurring` (below) disappears
 * along with everything else here for the same reason the spec gives for
 * ALSO putting that link on `/transactions`: "because that section is
 * absent when nothing is due".
 *
 * A blocked row (`row.blockedReason !== null`) withholds ONLY its Record
 * button, never a button that would fail the instant it was pressed —
 * `recordOccurrence` re-validates the wallet, the currency pairing, the
 * category and the pause state server-side regardless, but a button that
 * always fails is worse than no button, and the reason is already known at
 * render time (`buildDueRows` computed it from the same facts
 * `recordOccurrence` would re-check). Spec §4 draws this line at Record
 * specifically ("Its due items render with the reason stated rather than a
 * button that fails on press") and §1.3 requires every occurrence stay
 * "recordable or skippable on its own" — Skip renders on EVERY row,
 * blocked or not (fix round 1, C1, CRITICAL): `skipOccurrence` carries none
 * of Record's validation (no rule lookup, no archived check — RLS scopes it
 * through wallet MEMBERSHIP, which survives archiving), so it succeeds
 * regardless, and this codebase has no "restore" action for an archived
 * wallet. Withholding Skip too, as the first version of this component did,
 * left a blocked row with no way to ever leave this list: `dueOccurrences`
 * keeps regenerating it every reload, forever, and a rule with a monthly
 * schedule mints a new one every month on top — the section would plateau
 * into a wall of permanently-stuck rows and never be absent again, breaking
 * the exact §5 guarantee ("absent entirely when nothing is due") this
 * component exists to honour.
 *
 * **Skip is undoable** (fix round 2, I2): before this, a click on Skip —
 * one tap, no confirmation, sitting immediately next to Record — fired
 * `skipOccurrence` directly and the row vanished for good. `unskipOccurrence`
 * (src/server/actions/recurring.ts) already existed, already deletes the
 * skip row it undoes, and was already tested — it was simply never called
 * from anywhere outside its own test file. Spec §4 states plainly that
 * "Skipping is undoable by deleting the skip row," and this codebase's own
 * convention for a one-tap irreversible-from-here action is either a
 * confirmation (RecurringList's Pause) or an undo (TransactionList's
 * `UndoToast`) — a misclick next to Record is exactly the kind of accident
 * an undo, not a confirmation dialog, is the right answer for (confirming
 * would slow down the common, correct case of skipping a genuinely-unwanted
 * occurrence). `UndoToast` is reused unmodified, following the exact shape
 * TransactionList.tsx's own delete/undo already establishes: Skip succeeds
 * immediately (no dialog in the way), and the toast that appears offers
 * Undo, which calls `unskipOccurrence(ruleId, occurrenceOn)`. A retryable
 * failure on Undo re-offers itself relabelled "Retry" with `tone: "error"`,
 * mirroring TransactionList's `handleUndo` precisely — `unskipOccurrence`'s
 * only failure modes are "Not signed in" and a generic update failure, both
 * recoverable the identical way TransactionList's are, so there is no
 * "gone for good" branch here the way `restoreTransaction`'s
 * "Transaction not found" is.
 *
 * The section itself still disappears the instant `rows` is empty (spec §5
 * is about the DUE section, specifically) — but an active undo toast keeps
 * THIS component mounted regardless, because skipping the very LAST due row
 * makes `rows` empty on the very same render the toast needs to appear on.
 * Returning `null` unconditionally on an empty `rows` would unmount the
 * toast (and the undo it offers) in the same instant it was created.
 */
export function DueList({ rows, olderDropped, today }: { rows: DueRow[]; olderDropped: boolean; today: string }) {
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  /** Which row (or the toast's own undo/retry) is mid-request, keyed by
   *  `ruleId:occurrenceOn` — a SET, not the single `pendingKey` this field
   *  used to be, because a row's Skip and the toast's later Undo are two
   *  separate in-flight moments for the SAME key that must not be confused
   *  with each other's completion — matching TransactionList's identical
   *  `pendingIds` shape and reasoning for the same delete/undo pairing. */
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [, start] = useTransition();
  /** Focus-return target once the toast closes entirely — the row/button
   *  that triggered Skip is long gone by then (removed once `rows` no
   *  longer includes it), so focus would otherwise fall all the way back to
   *  `<body>`. Same technique, same reasoning, as TransactionList's
   *  `listRef`/`closeToast`. */
  const containerRef = useRef<HTMLDivElement>(null);

  // Nothing due AND no toast to show: render nothing, not an empty state —
  // see this component's own doc comment. An active toast (from skipping
  // the very last due row) keeps this mounted regardless.
  if (rows.length === 0 && !toast) return null;

  function closeToast() {
    setToast(null);
    containerRef.current?.focus();
  }

  function run(key: string, fn: () => Promise<void>) {
    setPendingIds((prev) => new Set(prev).add(key));
    start(async () => {
      try {
        await fn();
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    });
  }

  function handleRecord(row: DueRow) {
    setError(null);
    run(`${row.ruleId}:${row.occurrenceOn}`, async () => {
      // Returns its error rather than throwing — same reasoning as
      // WalletList's `archive`/RecurringList's `pause`: a thrown message
      // reaches the browser as an opaque digest in production.
      const res = await recordOccurrence(row.ruleId, row.occurrenceOn);
      if (res.error) setError(res.error);
    });
  }

  function handleUndoSkip(row: DueRow) {
    const key = `${row.ruleId}:${row.occurrenceOn}`;
    run(key, async () => {
      const res = await unskipOccurrence(row.ruleId, row.occurrenceOn);
      if (res.error) {
        // Same recoverable-failure shape as TransactionList's `handleUndo`:
        // `unskipOccurrence`'s only failures are "Not signed in" and a
        // generic update failure, both retryable, so the SAME action stays
        // offered, just relabelled and tinted to signal this is a retry.
        setToast({
          kind: "undo",
          id: key,
          message: res.error,
          actionLabel: "Retry",
          onAction: () => handleUndoSkip(row),
          tone: "error",
        });
        return;
      }
      closeToast();
    });
  }

  function handleSkip(row: DueRow) {
    setError(null);
    run(`${row.ruleId}:${row.occurrenceOn}`, async () => {
      const res = await skipOccurrence(row.ruleId, row.occurrenceOn);
      if (res.error) {
        setError(res.error);
        return;
      }
      setToast({
        kind: "undo",
        id: `${row.ruleId}:${row.occurrenceOn}`,
        message: `${row.ruleName} skipped`,
        actionLabel: "Undo",
        onAction: () => handleUndoSkip(row),
      });
    });
  }

  const undoPending = toast?.kind === "undo" && pendingIds.has(toast.id);

  return (
    <div ref={containerRef} tabIndex={-1} className="flex flex-col gap-2 focus:outline-none">
      {/* The heading/list themselves are absent exactly when `rows` is
          empty (spec §5) — independent of whether a toast is currently
          showing, so an e2e assertion that "Due" is gone once every
          occurrence is handled stays true even mid-undo-toast. */}
      {rows.length > 0 && (
        <section aria-labelledby="due-heading" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h2
              id="due-heading"
              className="text-sm font-medium uppercase tracking-wide"
              style={{ color: "var(--ink-2)" }}
            >
              Due
            </h2>
            {/* Spec §5: "/recurring ... Reached by a link from the DUE
                section on the dashboard, and — because that section is
                absent when nothing is due — also from /transactions." The
                /transactions half already exists (Task 5's page.tsx); this
                is the other half, and it disappears along with the rest of
                this section for the identical reason the spec gives for
                needing the other link at all. */}
            <Link
              href="/recurring"
              className={`shrink-0 rounded-sm text-sm underline ${FOCUS_RING}`}
              style={{ color: "var(--ink-2)" }}
            >
              Manage
            </Link>
          </div>

          {/* Always mounted, not conditionally rendered — see
              WalletList.tsx's identical paragraph for why a role="alert"
              that appears and gets its text in the same instant is not
              reliably announced. */}
          <p role="alert" className="text-sm" style={{ color: "var(--neg)" }}>
            {error}
          </p>

          <ul className="flex flex-col">
            {rows.map((row) => {
              const key = `${row.ruleId}:${row.occurrenceOn}`;
              const pending = pendingIds.has(key);
              const dateLabel = dueDateLabel(row.occurrenceOn, today);
              return (
                <li
                  key={key}
                  // No `aria-label` here (fix round 1, small): an
                  // aria-label on this element would REPLACE its accessible
                  // content entirely, dropping the amount and wallet name a
                  // screen reader would otherwise announce while stepping
                  // through this row's own text — the row's real content
                  // already names the rule and the date, and the buttons
                  // below carry their own rule-and-date labels for the
                  // reason described above.
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

                  {/* Withholds ONLY Record when blocked — see this
                      component's own doc comment (fix round 1, C1). The
                      reason renders alongside Skip, not instead of it. */}
                  {row.blockedReason && (
                    <p className="shrink-0 max-w-[35%] text-right text-xs" style={{ color: "var(--neg)" }}>
                      {row.blockedReason}
                    </p>
                  )}
                  {!row.blockedReason && (
                    <button
                      type="button"
                      disabled={pending}
                      aria-label={`Record ${row.ruleName} for ${dateLabel}`}
                      onClick={() => handleRecord(row)}
                      className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
                      style={{ background: "var(--cat-1)", color: "var(--surface)" }}
                    >
                      Record
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={`Skip ${row.ruleName} for ${dateLabel}`}
                    onClick={() => handleSkip(row)}
                    className={`shrink-0 rounded-md border px-3 py-2 text-sm disabled:opacity-60 ${FOCUS_RING}`}
                    style={{ borderColor: "var(--ink-2)", color: "var(--ink-2)" }}
                  >
                    Skip
                  </button>
                </li>
              );
            })}
          </ul>

          {/* States the backstop explicitly rather than letting a
              truncated list read as "you are up to date" —
              `occurrencesFor`'s own doc comment on `olderDropped` says
              exactly this. Wording is deliberately CAUSE-NEUTRAL (fix
              round 1, I3): `olderDropped` is true for either the 12-month
              floor OR the 24-occurrence cap, and the cap binds routinely
              (spec §1.5: a weekly rule's 52-ish yearly occurrences blow
              past 24 on their own), so a message naming "12 months" would
              be flatly wrong whenever the cap, not the floor, is what
              actually withheld rows — a weekly rule anchored exactly 12
              months back withholds occurrences that are ALL inside the
              last 12 months. What's true in both cases is only that
              something older was withheld, so that's all this says. */}
          {olderDropped && (
            <p className="text-xs" style={{ color: "var(--ink-2)" }}>
              Older occurrences aren’t shown here.
            </p>
          )}
        </section>
      )}

      <UndoToast toast={toast} onDismiss={closeToast} pending={undoPending} />
    </div>
  );
}
