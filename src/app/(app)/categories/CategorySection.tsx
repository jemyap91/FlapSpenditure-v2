"use client";

import { useId, useState, useTransition } from "react";
import { Check, Plus } from "lucide-react";
import { createCategory, archiveCategory } from "@/server/actions/categories";
import { slotVar, SLOT_COUNT } from "@/lib/palette";
import { CATEGORY_ICON_COMPONENTS } from "@/lib/category-icons";
import { CATEGORY_ICONS, nextColorSlot, type CategoryIcon } from "@/lib/validation/category";
import type { Category } from "@/components/CategoryPicker";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";
const SWATCH_FOCUS_RING =
  "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--cat-1)]";

const SLOTS = Array.from({ length: SLOT_COUNT }, (_, i) => i + 1);

/**
 * One kind's section of /categories: a list with per-row Archive, plus a
 * create form with a real colour-slot and icon picker (spec §5.3, line 240:
 * "The management screen, for deliberate curation. Fields: name, kind,
 * colour slot, icon.") — `createCategory` already accepted both params;
 * this is what was missing to actually offer them. A reviewer confirmed no
 * later Phase-1 task adds this UI elsewhere, so this is the one and only
 * place spec §5.3's "refinement happens later on /categories" promise can
 * be kept.
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
  walletId,
}: {
  kind: "expense" | "income";
  label: string;
  initial: Category[];
  walletId: string;
}) {
  const [items, setItems] = useState(initial);
  const [name, setName] = useState("");
  const [colorSlot, setColorSlot] = useState<number>(() =>
    nextColorSlot(initial.map((c) => c.color_slot)),
  );
  const [icon, setIcon] = useState<CategoryIcon>("circle");
  const [error, setError] = useState<string | null>(null);
  // Creating and archiving are tracked separately, and archiving is
  // tracked PER ROW (a Set of in-flight ids), not as one shared
  // `useTransition` pending flag for the whole section — a single shared
  // flag (the original version's `useTransition()`) went true for every
  // dispatch through it, so archiving one row disabled the Add button and
  // every OTHER row's Archive button in the same kind for the duration of
  // one request. Archiving doesn't need `useTransition`'s concurrent/
  // interruptible-render machinery (there's no Suspense boundary or
  // urgent update it needs to yield to here) — a plain in-flight id set
  // updated from a directly-awaited call is enough, and keeps every row
  // independent.
  const [archivingIds, setArchivingIds] = useState<ReadonlySet<string>>(new Set());
  const [creating, startCreate] = useTransition();
  const inputId = useId();
  const errorId = useId();

  function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    startCreate(async () => {
      const res = await createCategory({ name: trimmed, kind, color_slot: colorSlot, icon, wallet_id: walletId });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      const created = res.category;
      const nextItems = [...items, created];
      setItems(nextItems);
      setName("");
      setIcon("circle");
      // Recomputed against the just-updated list, not the stale `items`
      // closed over before this call — matches what the server would
      // auto-assign for the NEXT category, so the picker's default keeps
      // tracking "the current least-used slot" rather than freezing at
      // whatever it was when the section first mounted.
      setColorSlot(nextColorSlot(nextItems.map((c) => c.color_slot)));
    });
  }

  function archive(id: string) {
    setError(null);
    setArchivingIds((prev) => new Set(prev).add(id));
    void (async () => {
      const res = await archiveCategory(id);
      setArchivingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      // Archiving frees the name for reuse (categories_unique_active_name
      // is scoped to active rows only) — dropping the row from local state
      // immediately is what lets the "create the same name again" flow
      // this task's brief demands work without a manual refresh.
      setItems((prev) => prev.filter((c) => c.id !== id));
    })();
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
          const archiving = archivingIds.has(c.id);
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
                disabled={archiving}
                aria-label={`Archive ${c.name}`}
                className={`rounded px-2 py-1 text-sm disabled:opacity-60 ${FOCUS_RING}`}
                style={{ color: "var(--ink-2)" }}
              >
                {archiving ? "Archiving…" : "Archive"}
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

      {/* Explicit background (var(--surface), matching the list above)
          rather than inheriting the page's var(--page) — keeps every
          colour pair in this form on the same, already-measured pairing
          (glyph-vs-surface, --cat-1-vs-surface, --ink-2-vs-surface) instead
          of introducing a second background this task's contrast table
          would need to re-derive. */}
      <form
        className="mt-2 flex flex-col gap-3 rounded-lg border p-3"
        style={{ borderColor: "var(--grid)", background: "var(--surface)" }}
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <label htmlFor={inputId} className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            New {label.toLowerCase()} category name
          </span>
          <input
            id={inputId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`Add ${label.toLowerCase()} category`}
            aria-describedby={error ? errorId : undefined}
            className={`rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
            style={{ borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" }}
          />
        </label>

        <fieldset>
          <legend className="text-xs" style={{ color: "var(--ink-2)" }}>
            Colour
          </legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {SLOTS.map((slot) => {
              const selected = colorSlot === slot;
              return (
                <label key={slot} className="cursor-pointer">
                  <input
                    type="radio"
                    name={`${kind}-color-slot`}
                    value={slot}
                    checked={selected}
                    onChange={() => setColorSlot(slot)}
                    className="peer sr-only"
                    aria-label={`Colour ${slot}`}
                  />
                  {/* Selection is shown with more than the swatch's own
                      hue: a visible outline ring plus a Check glyph
                      overlay, not just "this circle is a different colour
                      from the others" (it can't be — the colour IS the
                      slot being chosen). The Check glyph is rendered in
                      var(--surface), which measures >= 3.09:1 against
                      every one of the 8 slot colours in both themes (this
                      task's report's existing glyph-vs-surface table,
                      recomputed here for the inverse pairing — same 8
                      background colours, so the same figures apply). */}
                  <span
                    aria-hidden
                    className={`flex h-7 w-7 items-center justify-center rounded-full ${SWATCH_FOCUS_RING}`}
                    style={{
                      background: slotVar(slot),
                      outline: selected ? "2px solid var(--ink)" : "2px solid transparent",
                      outlineOffset: 2,
                    }}
                  >
                    {selected && <Check size={14} aria-hidden style={{ color: "var(--surface)" }} />}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-xs" style={{ color: "var(--ink-2)" }}>
            Icon
          </legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {CATEGORY_ICONS.map((iconName) => {
              const Icon = CATEGORY_ICON_COMPONENTS[iconName];
              const selected = icon === iconName;
              return (
                <label key={iconName} className="cursor-pointer">
                  <input
                    type="radio"
                    name={`${kind}-icon`}
                    value={iconName}
                    checked={selected}
                    onChange={() => setIcon(iconName)}
                    className="peer sr-only"
                    aria-label={iconName.replace(/-/g, " ")}
                  />
                  {/* Same mitigation shape as src/components/shell/
                      Sidebar.tsx's active-nav-item indicator (border-left
                      colour change plus a second cue — there font-weight,
                      here the icon's own stroke colour), not the
                      background-alone approach that failed elsewhere on
                      this branch. var(--cat-1) measures 5.60:1 (light) /
                      5.20:1 (dark) against var(--surface); var(--ink-2)
                      (unselected) measures 7.73:1 / 9.72:1. */}
                  <span
                    aria-hidden
                    className={`flex h-7 w-7 items-center justify-center rounded-md ${SWATCH_FOCUS_RING}`}
                    style={{
                      borderLeft: `3px solid ${selected ? "var(--cat-1)" : "transparent"}`,
                      background: selected ? "var(--grid)" : "transparent",
                      color: selected ? "var(--cat-1)" : "var(--ink-2)",
                    }}
                  >
                    <Icon size={16} aria-hidden />
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <button
          type="submit"
          disabled={creating || !name.trim()}
          className={`flex w-fit items-center gap-1 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
          style={{ background: "var(--cat-1)", color: "var(--surface)" }}
        >
          <Plus size={14} aria-hidden />
          {creating ? "Adding…" : "Add"}
        </button>
        {/* Always mounted — see CategoryPicker.tsx's identical pattern and
            its doc comment for why a conditionally-mounted role="alert"
            isn't reliably announced. */}
        <p id={errorId} role="alert" className="text-sm" style={{ color: "var(--neg)" }}>
          {error}
        </p>
      </form>
    </section>
  );
}
