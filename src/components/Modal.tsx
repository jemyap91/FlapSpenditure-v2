"use client";

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";

/** Declared per-file, matching WalletList.tsx and BudgetList.tsx — this
 *  codebase has no shared ui module and introducing one is unrelated to
 *  the work in hand. */
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * A modal dialog, implemented rather than delegated to the native
 * <dialog> element.
 *
 * `<dialog>.showModal()` would supply focus trapping, Escape handling, the
 * top layer and an inert background for free — but jsdom 30 does not
 * implement it, so every unit test of a dialog's contents would be
 * exercising a polyfill instead of the behaviour that ships. That is the
 * shape of bug this codebase keeps finding: a guard whose environment has
 * removed its teeth. Doing the work explicitly costs more lines and buys
 * tests that run the same code the browser does.
 *
 * Deliberately NOT portalled. Nothing in this app renders a stacking
 * context that traps a `fixed` child, and a portal would put the dialog
 * outside the React tree its contents' server actions were rendered in.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Captured on open, restored on close: focus must not be left on an
  // element that has just been unmounted, which drops it to <body> and
  // strands a keyboard user at the top of the page.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      returnFocusRef.current?.focus();
    };
  }, [open]);

  /**
   * Every tabbable descendant, in DOM order. Recomputed per keypress
   * rather than cached: the contents are forms whose controls appear and
   * disappear (an error message, a pending state), so a list captured on
   * open goes stale.
   *
   * No visibility filter, deliberately. The obvious one — dropping
   * elements whose `offsetParent` is null — is a no-op in a browser and a
   * catastrophe in jsdom, which performs no layout and so reports
   * `offsetParent === null` for everything: the list comes back empty and
   * the trap silently stops trapping, under test only. It is also
   * unnecessary here, because this component UNMOUNTS its children when
   * closed rather than hiding them, so a hidden tabbable cannot occur.
   */
  const tabbables = useCallback(() => {
    const root = panelRef.current;
    if (!root) return [] as HTMLElement[];
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;

    const items = tabbables();
    if (items.length === 0) {
      // Nothing to move to — keep focus on the panel rather than letting
      // Tab walk into the page behind, which is still fully rendered.
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;

    if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || active === panelRef.current)) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      onKeyDown={onKeyDown}
    >
      {/* The backdrop is a sibling, not a parent: a click handler on a
          wrapper would also fire for clicks inside the panel that bubble
          up, closing the dialog whenever someone clicked its own contents.
          Not a <button> — it carries no accessible name and must stay out
          of the tab order; Escape and the panel's own Cancel are the
          documented ways out, and this is only a pointer convenience. */}
      <div
        data-testid="modal-backdrop"
        aria-hidden
        onClick={onClose}
        className="absolute inset-0"
        style={{ background: "rgb(0 0 0 / 0.6)" }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative z-10 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border p-4 ${FOCUS_RING}`}
        style={{ borderColor: "var(--grid)", background: "var(--surface)" }}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-sm font-medium" style={{ color: "var(--ink)" }}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className={`shrink-0 rounded-sm text-xs underline ${FOCUS_RING}`}
            style={{ color: "var(--ink-2)" }}
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
