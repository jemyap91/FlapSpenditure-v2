"use client";

import { useState, useTransition } from "react";
import { ArrowRightLeft } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { slotVar } from "@/lib/palette";
import { CATEGORY_ICON_COMPONENTS } from "@/lib/category-icons";
import type { CategoryIcon } from "@/lib/validation/category";
import { softDeleteTransaction, restoreTransaction } from "@/server/actions/transactions";
import { UndoToast, type ToastState } from "./UndoToast";

/**
 * `category_icon` is included alongside `color_slot` (the brief's draft
 * only carried the latter, rendering a plain coloured dot) so a row can
 * show the same icon+colour identity CategoryPicker.tsx and
 * CategorySection.tsx already use for the same category — colour is never
 * the only thing distinguishing a category (spec §6.1/§6.3: past 8
 * categories a colour slot repeats, so hue alone stops being unique).
 * `kind` is kept (not just derived from `category_name`) because a
 * transfer is identified by `kind === "transfer"`, not by the absence of a
 * category name — an expense/income row can ALSO have a null category
 * (the schema does not force `category_id` to be non-null; see
 * `supabase/migrations/0003_transactions.sql`), and that "Uncategorised"
 * case must render differently from a transfer.
 */
export type Row = {
  id: string;
  kind: "expense" | "income" | "transfer";
  amount_minor: number;
  currency_code: string;
  occurred_on: string;
  note: string | null;
  wallet_name: string;
  category_name: string | null;
  category_icon: string | null;
  color_slot: number | null;
};

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * `occurred_on` is a SQL `date` column — `"2026-08-13"`, no time part.
 * `new Date("2026-08-13")` (no time suffix) is parsed by the ECMA-262 spec
 * as UTC midnight, which renders as the PREVIOUS calendar day for any
 * viewer west of UTC — the mirror image of the bug
 * `TransactionForm.tsx`'s `todayLocalDate()` exists to avoid on the way
 * IN. Appending a bare (no `Z`, no offset) `T00:00:00` forces the other
 * parse branch the spec defines for date-TIME strings: local time. That
 * makes the displayed weekday/date match the calendar day actually stored,
 * regardless of the viewer's timezone offset.
 */
function formatDayHeading(occurredOn: string): string {
  const d = new Date(`${occurredOn}T00:00:00`);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function RowIcon({ row }: { row: Row }) {
  if (row.kind === "transfer") {
    // Transfers have no category (`category_id IS NULL` by the
    // `transfer_shape` CHECK constraint) and are not part of the
    // categorical palette (spec §6.1 reserves that palette for
    // categories) — a neutral ink-toned icon, not a guessed colour.
    return (
      <ArrowRightLeft aria-hidden size={16} style={{ color: "var(--ink-2)" }} className="shrink-0" />
    );
  }
  if (row.category_icon && row.color_slot) {
    const Icon =
      CATEGORY_ICON_COMPONENTS[row.category_icon as CategoryIcon] ?? CATEGORY_ICON_COMPONENTS.circle;
    return <Icon aria-hidden size={16} style={{ color: slotVar(row.color_slot) }} className="shrink-0" />;
  }
  // Genuinely uncategorised expense/income: no colour slot to draw an icon
  // from. A neutral dot rather than a wrong-coloured guess. `var(--muted)`
  // here is a DECORATIVE graphical swatch, not text — WCAG 1.4.11's 3:1
  // floor for non-text UI components applies, not 1.4.3's 4.5:1 for text,
  // and `var(--muted)` clears 3:1 against `var(--surface)`/`var(--page)`
  // in both themes (3.50:1/3.41:1 light, 4.85:1/5.41:1 dark) — unlike the
  // TEXT uses of `var(--muted)` this task's brief drafted elsewhere (day
  // heading, wallet name, Delete/Undo labels), which are replaced with
  // `var(--ink-2)` throughout this file for exactly that reason.
  return (
    <span
      aria-hidden
      className="block h-3 w-3 shrink-0 rounded-full"
      style={{ background: "var(--muted)" }}
    />
  );
}

/**
 * /transactions — the full ledger review screen (this task's brief) and
 * the route Task 19's add-transaction screen now redirects to on save
 * (see TransactionForm.tsx's doc comment for that decision).
 *
 * ## How a transfer's two legs are presented
 *
 * A transfer is two rows sharing one `transfer_id` (spec §3.2): one
 * negative leg on the source wallet, one positive leg on the destination
 * wallet (`supabase/migrations/0005_transfer_fn.sql`). This component
 * renders each leg as its OWN row — two "Transfer" entries, one negative
 * under the source wallet's name and one positive under the
 * destination's — rather than collapsing them into a single combined row.
 * Three reasons, together:
 *
 * 1. **RLS can make only one leg visible.** `transactions_member` is keyed
 *    on `is_wallet_member(wallet_id)` per ROW, not per transfer
 *    (`setDeletedAt`'s own doc comment in transactions.ts spells this out
 *    for the delete path, and the same asymmetry applies to reads: if
 *    membership on one wallet changes after the transfer was created, that
 *    leg simply is not in `data` at all). A view that assumes "a transfer
 *    is always exactly one combined row" cannot represent that state
 *    honestly — there would be nothing to combine WITH.
 * 2. **No extra query.** Building a single "A → B, 50.00" row needs the
 *    OTHER leg's wallet name, which this screen's query does not fetch
 *    (each row only carries its own `wallet_id`'s embed). Fetching it
 *    would mean a self-join or a second round trip for a feature this
 *    task's brief does not ask for.
 * 3. **It matches every other row's shape.** Each wallet's own ledger line
 *    reads the same way an expense/income row does: signed amount, this
 *    row's own wallet name underneath. A user reviewing "what happened to
 *    THIS wallet" sees a consistent, honest per-wallet entry instead of a
 *    special-cased combined row that behaves differently under partial
 *    visibility.
 *
 * Soft delete on a transfer leg still moves both rows together server-side
 * (`setDeletedAt` scopes the UPDATE by `transfer_id`, not `id`, when the
 * target is a transfer leg) — deleting either leg from this list removes
 * both from view in one action, exactly as verified in this task's report.
 * This component does not need to know that; it just renders whatever
 * `rows` the next server-rendered payload contains.
 *
 * ## Why deletion doesn't do its own optimistic row removal
 *
 * `softDeleteTransaction`/`restoreTransaction` both call
 * `revalidatePath("/", "layout")`. Per node_modules/next/dist/docs/01-app/
 * 02-guides/server-actions.md ("A single response carries data and UI"),
 * calling a Server Function from a client-side transition — which is what
 * `start(...)` below does, one of the three invocation mechanisms that
 * section names alongside `<form action>` and `<button formAction>` — gets
 * the SAME single-roundtrip behaviour: the revalidated RSC payload for the
 * current route comes back in the same response and is committed by the
 * router. `page.tsx`'s query already filters `.is("deleted_at", null)`, so
 * a successful delete makes the row disappear from the very `rows` prop
 * this component re-renders with, and a successful restore makes it
 * reappear — no separate client-side list-filtering state needed, and no
 * risk of that state disagreeing with what the database actually holds.
 */
export function TransactionList({ rows }: { rows: Row[] }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [, start] = useTransition();

  function run(id: string, fn: () => Promise<void>) {
    setPendingIds((prev) => new Set(prev).add(id));
    start(async () => {
      try {
        await fn();
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    });
  }

  function handleUndo(id: string) {
    run(id, async () => {
      // Surfaced, not assumed: an id that no longer exists (already
      // restored from another tab, or never existed) or a partial-transfer
      // guard failure comes back as `{ error }`, and the toast is made to
      // SAY so rather than silently clearing as if the restore had worked.
      const res = await restoreTransaction(id);
      if ("error" in res) {
        setToast({ kind: "error", message: res.error });
        return;
      }
      setToast(null);
    });
  }

  function handleDelete(row: Row) {
    const label = row.category_name ?? (row.kind === "transfer" ? "Transfer" : "Uncategorised");
    run(row.id, async () => {
      const res = await softDeleteTransaction(row.id);
      if ("error" in res) {
        setToast({ kind: "error", message: res.error });
        return;
      }
      setToast({
        kind: "undo",
        id: row.id,
        message: `${label} deleted`,
        actionLabel: "Undo",
        onAction: () => handleUndo(row.id),
      });
    });
  }

  const byDay = rows.reduce<Record<string, Row[]>>((acc, r) => {
    (acc[r.occurred_on] ??= []).push(r);
    return acc;
  }, {});

  const undoPending = toast?.kind === "undo" && pendingIds.has(toast.id);

  return (
    <>
      {rows.length === 0 ? (
        <p className="p-8 text-center text-sm" style={{ color: "var(--ink-2)" }}>
          No transactions yet. Add your first one to get started.
        </p>
      ) : (
        Object.entries(byDay).map(([day, list]) => (
          <section key={day}>
            <h2
              className="px-4 pt-4 text-xs font-medium uppercase tracking-wide"
              style={{ color: "var(--ink-2)" }}
            >
              {formatDayHeading(day)}
            </h2>
            <ul>
              {list.map((r) => {
                const pending = pendingIds.has(r.id);
                const label = r.category_name ?? (r.kind === "transfer" ? "Transfer" : "Uncategorised");
                return (
                  <li
                    key={r.id}
                    className="flex items-center gap-3 border-b px-4 py-3"
                    style={{ borderColor: "var(--grid)" }}
                  >
                    <RowIcon row={r} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate" style={{ color: "var(--ink)" }}>
                        {label}
                      </span>
                      <span className="block truncate text-xs" style={{ color: "var(--ink-2)" }}>
                        {r.wallet_name}
                      </span>
                    </span>
                    {/* Sign is always rendered (`−12.50`/`+3,200.00`);
                        colour only reinforces it, never replaces it (spec
                        §6.4). `var(--pos)`/`var(--neg)` both clear 4.5:1
                        against `var(--surface)`/`var(--page)` in both
                        themes — see this task's report's contrast table. */}
                    <span
                      className="shrink-0 tabular-nums"
                      style={{ color: r.amount_minor < 0 ? "var(--neg)" : "var(--pos)" }}
                    >
                      {formatMoney(r.amount_minor, r.currency_code, { signed: true })}
                    </span>
                    <button
                      type="button"
                      aria-label={`Delete ${label}`}
                      disabled={pending}
                      onClick={() => handleDelete(r)}
                      className={`shrink-0 text-xs underline disabled:opacity-60 ${FOCUS_RING}`}
                      style={{ color: "var(--ink-2)" }}
                    >
                      {pending ? "Deleting…" : "Delete"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      <UndoToast toast={toast} onDismiss={() => setToast(null)} pending={undoPending} />
    </>
  );
}
