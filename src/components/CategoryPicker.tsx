"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { createCategory } from "@/server/actions/categories";
import { slotVar } from "@/lib/palette";
import { CATEGORY_ICON_COMPONENTS } from "@/lib/category-icons";
import type { CategoryIcon } from "@/lib/validation/category";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * `kind` is required on every row: Task 19's add-transaction screen filters
 * this list by the transaction type currently selected (spec §5.1: the chip
 * row switches between Expense/Income/Transfer, and a transfer removes the
 * category chip entirely rather than disabling it).
 */
export type Category = {
  id: string;
  name: string;
  kind: "expense" | "income";
  color_slot: number;
  icon: string;
  /** Categories belong to a SPACE — a household — not to a wallet and not
   *  to a user (0022). Every wallet in the household draws on one list, so
   *  TransactionForm no longer narrows this by wallet before passing it on;
   *  the only narrowing left is by household, for the uncommon case of a
   *  user who belongs to two. */
  space_id: string;
};

/**
 * Category search + inline creation, for Task 19's add-transaction screen
 * (props are shaped for that consumer, not built here — see this task's
 * brief). Spec §5.3 calls this "the load-bearing" creation path: a user
 * standing at a till having typed an amount must never lose it just to add
 * a missing category, so creating one selects it and hands control straight
 * back to the caller via `onChange` rather than navigating anywhere.
 *
 * "The inline picker surfaces the existing match rather than the create row
 * when a name collides" (spec §5.3) — `canCreate` is false whenever the
 * (trimmed, case-insensitive) query already matches a visible category, so
 * the existing row is what's offered, never a doomed-to-fail duplicate
 * create action.
 */
export function CategoryPicker({
  categories,
  kind,
  value,
  onChange,
  spaceId,
}: {
  categories: Category[];
  kind: "expense" | "income";
  value: string | null;
  onChange: (c: Category) => void;
  spaceId: string;
}) {
  const [query, setQuery] = useState("");
  // Categories created inline during this mount, kept separately from the
  // `categories` prop rather than merged into a snapshot of it. Two bugs
  // this fixes together (both found in review, both would have first
  // surfaced in Task 19): (1) a `useState(categories)` snapshot reads the
  // prop once at mount — Task 19's chip row switches Expense/Income on the
  // SAME mounted picker (spec §5.1), and a snapshot would keep showing the
  // kind that was active at mount forever; deriving `items` fresh from
  // `categories`+`kind` on every render fixes that. (2) filtering `items`
  // by `kind` — the original version searched/deduped across BOTH kinds
  // whenever the caller passed an unfiltered list, so an income "Vet"
  // would silently suppress the create row for an expense "Vet", which the
  // per-kind partial unique index explicitly allows and spec §5.3's line
  // on reuse-across-kind requires to work.
  const [created, setCreated] = useState<Category[]>([]);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  const errorId = useId();

  const items = useMemo(() => {
    const byKind = categories.filter((c) => c.kind === kind);
    // `created` can include categories the parent's `categories` prop
    // hasn't caught up to yet (it revalidates async) — de-duped by id so a
    // just-created category never renders twice once the prop does catch
    // up, and filtered by `kind` so a category created while a different
    // kind was selected doesn't leak into this kind's list.
    // `spaceId` is checked as well as `kind`. Under 0008 this filter was on
    // the WALLET and fired constantly: a category created inline under wallet
    // A stayed listed after switching to wallet B, where selecting it
    // produced a transaction the composite FK refused. Space scoping removes
    // that case entirely — switching wallets inside one household no longer
    // changes which categories are legal. The filter survives only for the
    // uncommon case it is still real for: a user who belongs to two
    // households and switches to a wallet in the other one.
    const extra = created.filter(
      (c) => c.kind === kind && c.space_id === spaceId && !byKind.some((x) => x.id === c.id),
    );
    return [...byKind, ...extra];
  }, [categories, kind, created, spaceId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((c) => c.name.toLowerCase().includes(q)) : items;
  }, [items, query]);

  const trimmedQuery = query.trim();
  const exact = filtered.some((c) => c.name.toLowerCase() === trimmedQuery.toLowerCase());
  const canCreate = trimmedQuery.length > 0 && !exact;

  function create() {
    setError(null);
    start(async () => {
      const res = await createCategory({ name: trimmedQuery, kind, icon: "circle", space_id: spaceId });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      const c = res.category;
      setCreated((prev) => [...prev, c]);
      setQuery("");
      onChange(c); // select it and return control to the caller (e.g. the keypad)
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={labelId} className="sr-only">
        Search categories
      </label>
      <input
        id={labelId}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search categories"
        aria-describedby={error ? errorId : undefined}
        className={`rounded-md border px-3 py-2 ${FOCUS_RING}`}
        style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
      />
      {/* Always mounted, not conditionally rendered — an empty paragraph is
          silent, and mounting fresh content is what screen readers reliably
          announce (see src/app/onboarding/onboarding-form.tsx's identical
          pattern and its doc comment for why a conditionally-mounted
          role="alert" is not reliable across screen-reader/browser pairs). */}
      <p id={errorId} role="alert" style={{ color: "var(--neg)" }}>
        {error}
      </p>
      <ul
        className="max-h-64 overflow-y-auto rounded-md"
        style={{ background: "var(--surface)" }}
      >
        {filtered.length === 0 && !canCreate && (
          <li className="px-2 py-2 text-sm" style={{ color: "var(--ink-2)" }}>
            No categories yet.
          </li>
        )}
        {filtered.map((c) => {
          const Icon = CATEGORY_ICON_COMPONENTS[c.icon as CategoryIcon] ?? CATEGORY_ICON_COMPONENTS.circle;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onChange(c)}
                aria-pressed={value === c.id}
                className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left ${value === c.id ? "font-medium" : ""} ${FOCUS_RING}`}
                style={{
                  // Selection used to be indicated with `background:
                  // var(--grid)` alone — measured 1.29:1 (light) / 1.24:1
                  // (dark) against the unselected rows' background, the
                  // exact failure src/components/shell/Sidebar.tsx already
                  // found and documented (same token, same numbers). It
                  // also silently pulled every row's icon glyph onto a
                  // *different* background than the unselected rows sit
                  // on, which is what dropped 3 of the 8 category slots
                  // below the 3:1 floor for a selected row (review-caught:
                  // slots 2/4/6 measured 2.70/2.61/2.65 light,
                  // 2.48/2.58/2.53 dark against var(--grid)).
                  //
                  // Fix, copied from Sidebar's own mitigation: background
                  // stays var(--surface) — the <ul>'s own background,
                  // identical for every row regardless of selection — and
                  // selection is carried by a var(--cat-1) left border
                  // plus a font-weight change instead. var(--cat-1)
                  // measures 5.60:1 (light) / 5.20:1 (dark) against
                  // var(--surface), clearing 3:1 with more margin than
                  // Sidebar's own (measured against var(--grid) there)
                  // 4.34:1 / 4.18:1. Because the background is now
                  // constant, every slot's glyph sits on the SAME pairing
                  // whether selected or not — the 3.09–6.03:1 range this
                  // task's report already computed for glyph-vs-surface
                  // now covers the selected row too, not just unselected
                  // ones.
                  background: "transparent",
                  color: "var(--ink)",
                  borderLeft: `3px solid ${value === c.id ? "var(--cat-1)" : "transparent"}`,
                }}
              >
                {/* Colour + icon shape + name together, never colour alone —
                    a swatch that also carries meaning must not rely on hue
                    alone (spec §6.3's mitigation for status colours, applied
                    here to category identity for the same reason: category 9
                    onward reuses a colour slot, spec §6.1, so hue stops being
                    unique past 8 categories and the icon+label are what
                    still distinguish them). */}
                <Icon aria-hidden size={16} style={{ color: slotVar(c.color_slot) }} className="shrink-0" />
                <span>{c.name}</span>
              </button>
            </li>
          );
        })}
        {canCreate && (
          <li>
            <button
              type="button"
              onClick={create}
              disabled={pending}
              className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left disabled:opacity-60 ${FOCUS_RING}`}
              style={{ color: "var(--ink)" }}
            >
              <Plus size={16} aria-hidden className="shrink-0" />
              <span>{pending ? "Creating…" : <>Create &ldquo;{trimmedQuery}&rdquo;</>}</span>
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
