"use client";

import { useId, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { createCategory, archiveCategory } from "@/server/actions/categories";
import { slotVar } from "@/lib/palette";
import { CATEGORY_ICON_COMPONENTS } from "@/lib/category-icons";
import type { CategoryIcon } from "@/lib/validation/category";
import type { Category } from "@/components/CategoryPicker";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * One kind's section of /categories: a list with per-row Archive, plus a
 * name-only "Add" row that calls `createCategory` the same way the inline
 * picker does (auto-assigned colour slot and a default icon — spec §5.3:
 * "Refinement happens later on /categories, or never"). This *is* "later
 * on /categories" for a category that started life named wrong or
 * mis-kinded via the inline picker — full colour/icon re-assignment is not
 * built here (out of this task's scope; `createCategory`'s
 * `color_slot`/`icon` parameters already support a future editor calling
 * them directly), only creation and archiving, which is what this task's
 * verification bar exercises end-to-end.
 *
 * State is optimistic and local (`items`), mirroring CategoryPicker's own
 * pattern, rather than relying solely on `revalidatePath` — both
 * `createCategory` and `archiveCategory` also call `revalidatePath("/",
 * "layout")`, so a hard refresh (or navigating away and back) reflects the
 * database either way; the local state just avoids a full-page
 * server round-trip for what the caller already knows the result of.
 */
export function CategorySection({
  kind,
  label,
  initial,
}: {
  kind: "expense" | "income";
  label: string;
  initial: Category[];
}) {
  const [items, setItems] = useState(initial);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const inputId = useId();
  const errorId = useId();

  function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    start(async () => {
      const res = await createCategory({ name: trimmed, kind, icon: "circle" });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setItems((prev) => [...prev, res.category as Category]);
      setName("");
    });
  }

  function archive(id: string) {
    setError(null);
    start(async () => {
      const res = await archiveCategory(id);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      // Archiving frees the name for reuse (categories_unique_active_name
      // is scoped to active rows only) — dropping the row from local state
      // immediately is what lets the "create the same name again" flow
      // this task's brief demands work without a manual refresh.
      setItems((prev) => prev.filter((c) => c.id !== id));
    });
  }

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-sm uppercase" style={{ color: "var(--ink-2)" }}>
        {label}
      </h2>
      <ul
        className="rounded-lg border"
        style={{ borderColor: "var(--grid)", background: "var(--surface)" }}
      >
        {items.map((c) => {
          const Icon =
            CATEGORY_ICON_COMPONENTS[c.icon as CategoryIcon] ?? CATEGORY_ICON_COMPONENTS.circle;
          return (
            <li
              key={c.id}
              className="flex items-center gap-3 border-b px-4 py-3 last:border-0"
              style={{ borderColor: "var(--grid)" }}
            >
              <Icon aria-hidden size={16} style={{ color: slotVar(c.color_slot) }} className="shrink-0" />
              <span className="flex-1" style={{ color: "var(--ink)" }}>
                {c.name}
              </span>
              <button
                type="button"
                onClick={() => archive(c.id)}
                disabled={pending}
                aria-label={`Archive ${c.name}`}
                className={`rounded px-2 py-1 text-sm disabled:opacity-60 ${FOCUS_RING}`}
                style={{ color: "var(--ink-2)" }}
              >
                Archive
              </button>
            </li>
          );
        })}
        {items.length === 0 && (
          <li className="px-4 py-3 text-sm" style={{ color: "var(--ink-2)" }}>
            No {label.toLowerCase()} categories.
          </li>
        )}
      </ul>

      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          New {label.toLowerCase()} category name
        </label>
        <input
          id={inputId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`Add ${label.toLowerCase()} category`}
          aria-describedby={error ? errorId : undefined}
          className={`flex-1 rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
          style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
        />
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className={`flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
          style={{ background: "var(--cat-1)", color: "var(--surface)" }}
        >
          <Plus size={14} aria-hidden />
          {pending ? "Adding…" : "Add"}
        </button>
      </form>
      {/* Always mounted — see CategoryPicker.tsx's identical pattern and its
          doc comment for why a conditionally-mounted role="alert" isn't
          reliably announced. */}
      <p id={errorId} role="alert" className="mt-1 text-sm" style={{ color: "var(--neg)" }}>
        {error}
      </p>
    </section>
  );
}
