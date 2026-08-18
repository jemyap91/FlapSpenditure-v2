"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * `id` on the `"undo"` variant lets the caller (TransactionList) look up
 * whether ITS row's restore is currently in flight (`pendingIds.has(id)`)
 * without this component needing its own notion of "pending" — it just
 * renders whatever `pending` prop it's handed.
 *
 * `tone` is independent of `kind`. A `"undo"` toast can carry
 * `tone: "error"` — review's Important 1 finding: `restoreTransaction`
 * failing with `"Not signed in"` or `"Could not update transaction"` (or a
 * partial-transfer `softDeleteTransaction` failure that left some rows
 * genuinely soft-deleted) is RECOVERABLE, and the only way back once the
 * row has dropped out of `rows` is this toast's own action button. Only
 * `"Transaction not found"` — the row is genuinely, permanently gone — has
 * nothing left to act on, so ONLY that case renders as a plain `"error"`
 * toast with no action. `tone: "error"` on an `"undo"` toast still shows
 * the red accent so the user can tell this is a retry offer following a
 * failure, not the original delete confirmation.
 */
export type ToastState =
  | {
      kind: "undo";
      id: string;
      message: string;
      actionLabel: string;
      onAction: () => void;
      tone?: "default" | "error";
    }
  | { kind: "error"; message: string };

/**
 * The delete/undo notification for /transactions. Spec §5.1 describes a
 * five-second auto-expiring undo toast for the ADD flow — this is a
 * deliberately different shape for Task 20's delete-from-the-list flow,
 * because this task's brief is explicit that a toast which "only appears
 * visually and vanishes on a timer is unusable for screen-reader and
 * keyboard users." There is no timer here: the toast stays until the user
 * acts on it (Undo/Retry), dismisses it, or triggers a new delete that
 * replaces it.
 *
 * Two separate nodes carry the two separate jobs a toast has to do:
 *
 * 1. **Announcement** — an always-mounted, visually-hidden `role="status"`
 *    region whose text content is the only thing that ever changes.
 *    Mounting a FRESH `role="status"`/`role="alert"` node and expecting it
 *    to be announced is not reliable across screen-reader/browser pairs —
 *    the same finding this codebase already made and documented for
 *    CategoryPicker.tsx's and TransactionForm.tsx's error paragraphs (see
 *    their doc comments). Keeping this node permanently mounted and only
 *    ever changing its text is what actually gets picked up. The
 *    announced text names the affordance, not just the event — "Groceries
 *    deleted. Undo available." — not just "Groceries deleted," which told
 *    a screen-reader user something happened but not that anything could
 *    be done about it (review-caught).
 * 2. **Interaction** — an ordinary, conditionally-mounted visible box with
 *    real `<button>`s for the action (Undo/Retry) and Dismiss. Unlike the
 *    announcement node, a plain interactive element has no such
 *    reliability problem: a keyboard user reaches it the instant it exists
 *    in the DOM (the same as any other conditionally-rendered control in
 *    this codebase, e.g. CategoryPicker's "Create <query>" row). This box
 *    deliberately carries NO `role`/`aria-live` of its own — giving it one
 *    too would risk a second, redundant announcement of the same text on
 *    browser/AT combinations where a newly-mounted live region does happen
 *    to fire.
 *
 * **Focus management** (review-caught: the clicked Delete button unmounts
 * with its row on revalidation, so focus was falling all the way back to
 * `<body>`, leaving a keyboard user to Tab past the skip link, the sidebar
 * and every remaining row's Delete button just to reach Undo). Every time
 * a NEW toast object appears, focus moves onto its primary control: the
 * action button for an `"undo"` toast, the Dismiss button otherwise. The
 * effect is keyed on the `toast` object itself, not on `pending` — a
 * pending-state change re-renders this component without creating a new
 * `toast` object, so focus is left alone while the SAME toast is merely
 * waiting on its in-flight request, exactly when a user is most likely to
 * already be sitting on that button. Returning focus somewhere sensible
 * once the toast closes entirely is the caller's job (TransactionList's
 * `closeToast`), since only the caller has a stable landing spot to
 * return it to.
 *
 * Every colour pair here was checked in both themes (see this task's
 * report): message text is `var(--ink)` on `var(--surface)` (19.17:1 light
 * / 17.42:1 dark), the Dismiss glyph and its `aria-label` text are
 * `var(--ink-2)` on `var(--surface)` (7.73:1 / 9.72:1) — never
 * `var(--muted)`, which measures 3.50:1/3.41:1 against
 * `var(--surface)`/`var(--page)` in light mode and fails AA for text. The
 * toast's own OUTER border — its only boundary against the page besides
 * `shadow-lg`, which review correctly flagged as, alone, an insufficient
 * 3:1 non-text-UI-component boundary (`var(--surface)` on `var(--page)`
 * measures 1.03:1 light / 1.12:1 dark; `var(--grid)`, the brief's original
 * choice, measures only 1.26:1 / 1.39:1 against `var(--page)`, nowhere
 * near WCAG 1.4.11's 3:1 floor) — is `var(--muted)`, which measures
 * 3.41:1 (light) / 5.41:1 (dark) against `var(--page)`, clearing that
 * floor in both themes. The 3px LEFT accent stays `var(--neg)` (4.56:1
 * light / 6.02:1 dark against `var(--page)`) whenever `tone === "error"`,
 * `var(--muted)` otherwise — same reasoning, same floor.
 */
export function UndoToast({
  toast,
  onDismiss,
  pending = false,
}: {
  toast: ToastState | null;
  onDismiss: () => void;
  pending?: boolean;
}) {
  const actionRef = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!toast) return;
    if (toast.kind === "undo") actionRef.current?.focus();
    else dismissRef.current?.focus();
  }, [toast]);

  const srText = !toast
    ? ""
    : toast.kind === "undo"
      ? `${toast.message}. ${toast.actionLabel} available.`
      : toast.message;

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {srText}
      </div>

      {toast && (
        <div
          className="fixed inset-x-4 bottom-24 z-50 flex items-center justify-between gap-3 rounded-lg px-4 py-3 shadow-lg md:bottom-6 md:left-auto md:right-6 md:w-96"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--muted)",
            borderLeft: `3px solid ${toast.kind === "error" || toast.tone === "error" ? "var(--neg)" : "var(--muted)"}`,
            color: "var(--ink)",
          }}
        >
          <span className="text-sm">{toast.message}</span>
          <div className="flex shrink-0 items-center gap-3">
            {toast.kind === "undo" && (
              <button
                ref={actionRef}
                type="button"
                onClick={toast.onAction}
                disabled={pending}
                className={`text-sm font-medium underline disabled:opacity-60 ${FOCUS_RING}`}
                style={{ color: "var(--ink)" }}
              >
                {pending ? "Restoring…" : toast.actionLabel}
              </button>
            )}
            <button
              ref={dismissRef}
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss notification"
              className={`rounded p-1 ${FOCUS_RING}`}
              style={{ color: "var(--ink-2)" }}
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
