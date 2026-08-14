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
}: {
  categories: Category[];
  kind: "expense" | "income";
  value: string | null;
  onChange: (c: Category) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState(categories);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  const errorId = useId();

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
      const res = await createCategory({ name: trimmedQuery, kind, icon: "circle" });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      const c = res.category as Category;
      setItems((prev) => [...prev, c]);
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
                className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left ${FOCUS_RING}`}
                style={{ background: value === c.id ? "var(--grid)" : "transparent", color: "var(--ink)" }}
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
