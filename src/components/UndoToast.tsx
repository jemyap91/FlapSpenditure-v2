"use client";

import { X } from "lucide-react";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * `id` on the `"undo"` variant lets the caller (TransactionList) look up
 * whether ITS row's restore is currently in flight (`pendingIds.has(id)`)
 * without this component needing its own notion of "pending" — it just
 * renders whatever `pending` prop it's handed.
 */
export type ToastState =
  | { kind: "undo"; id: string; message: string; actionLabel: string; onAction: () => void }
  | { kind: "error"; message: string };

/**
 * The delete/undo notification for /transactions. Spec §5.1 describes a
 * five-second auto-expiring undo toast for the ADD flow — this is a
 * deliberately different shape for Task 20's delete-from-the-list flow,
 * because this task's brief is explicit that a toast which "only appears
 * visually and vanishes on a timer is unusable for screen-reader and
 * keyboard users." There is no timer here: the toast stays until the user
 * acts on it (Undo), dismisses it, or triggers a new delete that replaces
 * it.
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
 *    ever changing its text is what actually gets picked up.
 * 2. **Interaction** — an ordinary, conditionally-mounted visible box with
 *    real `<button>`s for Undo and Dismiss. Unlike the announcement node,
 *    a plain interactive element has no such reliability problem: a
 *    keyboard user reaches it the instant it exists in the DOM (the same
 *    as any other conditionally-rendered control in this codebase, e.g.
 *    CategoryPicker's "Create <query>" row). This box deliberately carries
 *    NO `role`/`aria-live` of its own — giving it one too would risk a
 *    second, redundant announcement of the same text on browser/AT
 *    combinations where a newly-mounted live region does happen to fire.
 *
 * Every colour pair here was checked in both themes (see this task's
 * report): message text is `var(--ink)` on `var(--surface)` (19.17:1 light
 * / 17.42:1 dark), the Dismiss glyph and its `aria-label` text are
 * `var(--ink-2)` on `var(--surface)` (7.73:1 / 9.72:1) — never
 * `var(--muted)`, which measures 3.50:1/3.41:1 against
 * `var(--surface)`/`var(--page)` in light mode and fails AA for text.
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
  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {toast?.message ?? ""}
      </div>

      {toast && (
        <div
          className="fixed inset-x-4 bottom-24 z-50 flex items-center justify-between gap-3 rounded-lg px-4 py-3 shadow-lg md:bottom-6 md:left-auto md:right-6 md:w-96"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--grid)",
            borderLeft: `3px solid ${toast.kind === "error" ? "var(--neg)" : "var(--grid)"}`,
            color: "var(--ink)",
          }}
        >
          <span className="text-sm">{toast.message}</span>
          <div className="flex shrink-0 items-center gap-3">
            {toast.kind === "undo" && (
              <button
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
