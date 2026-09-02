"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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
 *
 * `note` and `merchant` are both carried and both rendered — see page.tsx's
 * doc comment on its select for why (`note` was excluded for a while on
 * review, having been fetched and typed here without ever being rendered, a
 * dead payload on every request; that is no longer true of either column).
 */
export type Row = {
  id: string;
  kind: "expense" | "income" | "transfer";
  amount_minor: number;
  currency_code: string;
  occurred_on: string;
  wallet_name: string;
  /** The transactions table's own `merchant` column (<=120 chars). Who the
   *  money went to/came from — a shorter, more structured cousin of `note`
   *  (below), and the row's primary line when present (`merchantOf`).
   *  Nullable, and may also arrive as "" — `merchantOf` below treats both as
   *  absent, for the same reason `noteOf` does. */
  merchant: string | null;
  /** The transactions table's own `note` column (<=280 chars). Freeform,
   *  and secondary to `merchant` when both are present (see `rowLabel`).
   *  Nullable, and may also arrive as "" — `noteOf` below treats both as
   *  absent. */
  note: string | null;
  category_name: string | null;
  category_icon: string | null;
  color_slot: number | null;
  /** Who created this row (`transactions.created_by`, resolved to a display
   *  name — see this component's doc comment and page.tsx's for why that
   *  resolution goes through `get_wallet_members()`, not a `profiles`
   *  embed/join). Null both when the column itself is null (`on delete set
   *  null`, so a departed account's past rows have no author) and, more
   *  routinely, whenever `showAttribution` is false and the page never
   *  bothered to resolve it. Either way, rendering is driven by
   *  `showAttribution`, not by whether this happens to be non-null. */
  created_by_name: string | null;
};

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * `occurred_on` is a SQL `date` column — `"2026-08-13"`, no time part.
 * `new Date("2026-08-13")` (no time suffix) is parsed by the ECMA-262 spec
 * as UTC midnight, which renders as the PREVIOUS calendar day for any
 * viewer west of UTC — the mirror image of the bug
 * `src/lib/today.ts`'s `todayLocalDate()` exists to avoid on the way
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

/** What a row's own line shows — accurate even when there's genuinely no
 * category ("Uncategorised" is real, informative content there). */
/** A note that is present but blank is not a name. The zod schemas accept
 *  `""` (the actions coerce it to null on write), so a row can still reach
 *  the client with one — rendering that as the primary line would give the
 *  row an empty heading. */
function noteOf(row: Row): string | null {
  const trimmed = row.note?.trim();
  return trimmed ? trimmed : null;
}

/** A merchant that is present but blank is not a name — the same reasoning
 *  as `noteOf` above, for the same reason: the zod schemas accept `""` (the
 *  actions coerce it to null on write), so a row can still reach the client
 *  with one, and rendering that as the primary line would give the row an
 *  empty heading. */
function merchantOf(row: Row): string | null {
  const trimmed = row.merchant?.trim();
  return trimmed ? trimmed : null;
}

/** What the row's primary line says. The merchant wins when present: it is
 *  the most specific name available for this transaction — who the money
 *  actually went to/came from. The note is next: still a name the user
 *  chose, just less structured than a merchant. The category is last before
 *  the generic fallback. Nothing is dropped when a more specific field
 *  wins — whatever loses moves to the secondary line beside the wallet (see
 *  the row markup below). */
function rowLabel(row: Row): string {
  return (
    merchantOf(row) ?? noteOf(row) ?? row.category_name ?? (row.kind === "transfer" ? "Transfer" : "Uncategorised")
  );
}

/**
 * What a TOAST says was deleted. Deliberately NOT `rowLabel` for the
 * uncategorised case: "Uncategorised deleted" reads like something broke
 * (review-caught) — "Transaction deleted" says the same true thing without
 * sounding like a defect. The row's own line still says "Uncategorised";
 * only the toast's wording differs.
 */
function toastSubject(row: Row): string {
  return (
    merchantOf(row) ?? noteOf(row) ?? row.category_name ?? (row.kind === "transfer" ? "Transfer" : "Transaction")
  );
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
 *
 * ## Why the ERROR branches call `router.refresh()`
 *
 * `revalidatePath` only runs on `setDeletedAt`'s SUCCESS path
 * (`transactions.ts`) — on any `{ error }` return it has already returned
 * before reaching that call. That's fine when nothing changed. It is NOT
 * fine for `"Only part of this transfer could be updated"`: `setDeletedAt`
 * runs its UPDATE FIRST and only afterwards compares the affected-row
 * count against what was expected, so on that specific error some rows
 * genuinely WERE soft-deleted (or restored) in the database before the
 * mismatch was detected. Without a refresh, this component — which, by
 * design (previous section), does no optimistic client-side row removal —
 * would keep rendering those rows as if nothing had happened: stale,
 * disagreeing with the database (review-caught, Important 2). Calling
 * `router.refresh()` in every error branch (not just that one — it's a
 * harmless no-op re-fetch when nothing actually changed, and cheap
 * insurance against reasoning precisely about which of `setDeletedAt`'s
 * four error strings can and cannot leave partial state) makes the list
 * reconcile against the server every time, success or failure alike.
 */
export function TransactionList({
  rows,
  // Off by default: every existing caller/test that doesn't pass this prop
  // must keep rendering exactly as before (no attribution), matching the
  // "solo wallet" default this page.tsx computes for a wallet with no
  // co-members.
  showAttribution = false,
  // Both default to /transactions' own original copy, so every existing
  // caller/test that doesn't pass these keeps rendering exactly as before.
  // Task 3 (wallets/[id]/page.tsx) is the first caller to override them —
  // that screen is scoped to one wallet, so its accessible name and empty
  // state say so ("Transactions in <wallet name>" /
  // "No transactions in this wallet yet."), pinned by the wallet-detail
  // plan's controller addendum. Overridable here rather than forked into a
  // second component, which is exactly the reuse this task's brief asks
  // for: the money formatting, transfer labelling, and undo-based delete
  // below are shared unmodified.
  listLabel = "Transaction list",
  emptyMessage = "No transactions yet. Add your first one to get started.",
  // Fix round 1, Minor 1 (editable-transactions plan): where a row's edit
  // link should send the user BACK to after a successful save. An origin
  // IDENTIFIER (`wallet:<uuid>`) — never a path or a URL. Undefined on the
  // screens that have no more specific home than the global list
  // (/transactions), which keeps their behaviour byte-identical: no query
  // string on the href at all, and `parseOrigin(undefined)` resolves to
  // "/transactions", the destination those screens already used.
  origin,
}: {
  rows: Row[];
  showAttribution?: boolean;
  listLabel?: string;
  emptyMessage?: string;
  origin?: string;
}) {
  const router = useRouter();
  const [toast, setToast] = useState<ToastState | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [, start] = useTransition();
  // Programmatic focus target for when the toast closes entirely (Dismiss,
  // or a successful Undo) — the row/button that triggered it is long gone
  // by then (removed by revalidation), so focus would otherwise fall all
  // the way back to <body> (review-caught). `tabIndex={-1}` makes this
  // focusable without adding a new stop to the normal Tab order, the same
  // technique (app)/layout.tsx's <main> and TransactionForm.tsx's amount
  // group already use in this codebase.
  const listRef = useRef<HTMLDivElement>(null);

  function closeToast() {
    setToast(null);
    listRef.current?.focus();
  }

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
      const res = await restoreTransaction(id);
      if ("error" in res) {
        // See this component's doc comment: some of setDeletedAt's error
        // strings can follow a genuine (partial) database change, so the
        // list is reconciled against the server regardless of which one
        // this is.
        router.refresh();
        if (res.error === "Transaction not found") {
          // Genuinely, permanently gone — there is nothing left to act
          // on, so this is the one case with no action button.
          setToast({ kind: "error", message: res.error });
          return;
        }
        // Every other failure ("Not signed in," "Could not update
        // transaction," a partial-transfer mismatch) is recoverable: an
        // expired session can be re-authenticated in another tab, a
        // transient update failure can succeed on retry, and re-running
        // the same transfer-scoped restore repairs a partial one. Losing
        // the only path back to a soft-deleted row over a retryable
        // failure would be worse than the failure itself (review-caught,
        // Important 1) — so the SAME action (retry the restore) stays
        // offered, just relabelled and tinted to signal this is a retry
        // following a failure, not the original offer.
        setToast({
          kind: "undo",
          id,
          message: res.error,
          actionLabel: "Retry",
          onAction: () => handleUndo(id),
          tone: "error",
        });
        return;
      }
      closeToast();
    });
  }

  function handleDelete(row: Row) {
    run(row.id, async () => {
      const res = await softDeleteTransaction(row.id);
      if ("error" in res) {
        // Same reconciliation reasoning as handleUndo's error branch.
        router.refresh();
        if (res.error === "Only part of this transfer could be updated") {
          // Some rows sharing this transfer_id genuinely WERE soft-deleted
          // before the mismatch was caught — offering Undo here isn't the
          // original delete-confirmation offer, it's a repair action:
          // restoreTransaction is scoped by transfer_id too, so retrying
          // it un-deletes whatever this partial delete actually touched.
          setToast({
            kind: "undo",
            id: row.id,
            message: res.error,
            actionLabel: "Undo",
            onAction: () => handleUndo(row.id),
            tone: "error",
          });
          return;
        }
        // "Not signed in" / "Could not update transaction": a single
        // UPDATE statement is atomic, so neither of these can have
        // changed anything — the row is still exactly where it was, still
        // showing its own Delete button, which IS the retry path. No
        // action button needed on the toast itself.
        setToast({ kind: "error", message: res.error });
        return;
      }
      setToast({
        kind: "undo",
        id: row.id,
        message: `${toastSubject(row)} deleted`,
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
    <div
      ref={listRef}
      tabIndex={-1}
      // `role="region"` (not just `aria-label` on a bare div, which a
      // generic/no-role element does not reliably expose an accessible name
      // FOR) is what makes this a landmark a screen-reader user can jump to
      // and a `getByRole("region", { name: ... })` query can find — the
      // wallet-detail plan's controller addendum pins the exact name this
      // must carry per screen.
      role="region"
      aria-label={listLabel}
      className="focus:outline-none"
    >
      {rows.length === 0 ? (
        <p className="p-8 text-center text-sm" style={{ color: "var(--ink-2)" }}>
          {emptyMessage}
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
                const label = rowLabel(r);
                const amountText = formatMoney(r.amount_minor, r.currency_code, { signed: true });
                return (
                  <li
                    key={r.id}
                    className="flex items-center gap-3 border-b px-4 py-3"
                    style={{ borderColor: "var(--grid)" }}
                  >
                    <RowIcon row={r} />
                    <span className="min-w-0 flex-1">
                      {/* Task 6 (editable-transactions plan): the row's
                          PRIMARY LABEL is the entry point into editing it,
                          not the whole row — the row already contains a
                          Delete <button>, and wrapping that in a link would
                          nest one interactive element inside another
                          (invalid HTML, ambiguous click target).
                          `WalletList.tsx` already solved this exact problem
                          (its own doc comment: "the wallet's NAME is the
                          link into its detail screen"); this follows that
                          precedent for the same reason.

                          The link's accessible name is `label` alone —
                          nothing else inside this anchor — so it matches
                          exactly what the Delete button below already
                          announces (`Delete ${label}, ${amountText}`): a
                          row cannot name itself one thing to a link and
                          another to its delete control.

                          `?from=<origin>` (fix round 1, Minor 1) carries
                          this screen's identity to the edit page, which
                          threads it into TransactionForm so a save returns
                          the user where they came from instead of dumping
                          them on the global list. Written unencoded to match
                          `WalletFab.tsx`'s identical `?from=wallet:<id>`
                          construction — the identifier grammar is fixed
                          (`wallet:` plus a uuid, both of them
                          `parseOrigin`'s own contract in @/lib/origin), so
                          there is no character in it to escape. Nothing here
                          trusts it either way: `parseOrigin` re-validates
                          the shape on arrival and BUILDS the path itself,
                          which is what keeps a query param from becoming an
                          open redirect. Omitted entirely when `origin` is
                          undefined, so a caller that passes nothing gets
                          exactly the href it had before. */}
                      <Link
                        href={`/transactions/${r.id}/edit${origin ? `?from=${origin}` : ""}`}
                        className={`block truncate rounded-sm ${FOCUS_RING}`}
                        style={{ color: "var(--ink)" }}
                      >
                        {label}
                      </Link>
                      {/* Whatever the primary line didn't use joins the
                          wallet here rather than being dropped — the row
                          still carries everything it did before, just
                          reordered by specificity. When a merchant took the
                          primary line, the note demotes to this line beside
                          the category, exactly as the category already
                          demoted when the note used to be the primary line
                          on its own. Attribution (when `showAttribution` —
                          a wallet with more than one member, see page.tsx)
                          is appended last, and only when this row actually
                          has an author: a departed account's rows
                          (`created_by` is `on delete set null`) carry
                          `created_by_name: null` and must render with no
                          "added by" segment at all, not a blank/"undefined"
                          one. */}
                      <span className="block truncate text-xs" style={{ color: "var(--ink-2)" }}>
                        {[
                          merchantOf(r) && noteOf(r) ? noteOf(r) : null,
                          (merchantOf(r) || noteOf(r)) && r.category_name ? r.category_name : null,
                          r.wallet_name,
                          showAttribution && r.created_by_name ? `added by ${r.created_by_name}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    {/* Sign is always rendered (`−12.50`/`+3,200.00`);
                        colour only reinforces it, never replaces it (spec
                        §6.4). `var(--pos)`/`var(--neg)` both clear 4.5:1
                        against `var(--page)` (this row's actual background
                        — see this task's report's corrected contrast
                        table) in both themes. */}
                    <span
                      className="shrink-0 tabular-nums"
                      style={{ color: r.amount_minor < 0 ? "var(--neg)" : "var(--pos)" }}
                    >
                      {amountText}
                    </span>
                    <button
                      type="button"
                      // Includes the amount, not just the category name —
                      // several rows can share "Delete Groceries" as an
                      // accessible name otherwise (review-caught); the
                      // amount is already visible next to the button, so a
                      // screen-reader user hears the same disambiguator a
                      // sighted user already sees.
                      aria-label={`Delete ${label}, ${amountText}`}
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

      <UndoToast toast={toast} onDismiss={closeToast} pending={undoPending} />
    </div>
  );
}
