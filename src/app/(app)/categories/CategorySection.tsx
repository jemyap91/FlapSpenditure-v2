"use client";

import { memo, useCallback, useId, useState, useTransition } from "react";
import { Check, Plus } from "lucide-react";
import { createCategory, updateCategory, archiveCategory } from "@/server/actions/categories";
import { Modal } from "@/components/Modal";
import { slotVar, SLOT_COUNT } from "@/lib/palette";
import { CATEGORY_ICON_COMPONENTS, CATEGORY_ICON_GROUPS } from "@/lib/category-icons";
import { nextColorSlot, type CategoryIcon } from "@/lib/validation/category";
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
  spaceId,
}: {
  kind: "expense" | "income";
  label: string;
  initial: Category[];
  spaceId: string;
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
  /** Which category's edit dialog is open, plus the draft being edited.
   *  `originalName` is kept separately so the dialog's title stays put while
   *  the user types — a heading that renames itself keystroke by keystroke
   *  is what a screen reader would re-announce on every character. */
  const [editing, setEditing] = useState<{
    id: string;
    originalName: string;
    name: string;
    colorSlot: number;
    icon: CategoryIcon;
  } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  // Functional updates, so these keep one identity for the life of the
  // component — which is what lets IconPicker's memo actually hold.
  const setEditIcon = useCallback(
    (next: CategoryIcon) => setEditing((prev) => (prev ? { ...prev, icon: next } : prev)),
    [],
  );
  const setEditColour = useCallback(
    (slot: number) => setEditing((prev) => (prev ? { ...prev, colorSlot: slot } : prev)),
    [],
  );
  const editErrorId = useId();
  const inputId = useId();
  const errorId = useId();

  function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      // Says why, rather than returning in silence. The Add button used to
      // carry `disabled={... || !name.trim()}`, whose only cue was
      // `disabled:opacity-60` — in the dark theme that reads as an ordinary
      // button that does nothing when tapped, with no message anywhere,
      // which is what "the add button doesn't work" turned out to mean.
      // This file's own `role="alert"` was already mounted below and simply
      // never received anything, because the early return above set no
      // error. Matches the convention TransactionForm.tsx states directly:
      // "a greyed-out control invites a click that can never succeed".
      setError("Name is required");
      return;
    }
    setError(null);
    startCreate(async () => {
      const res = await createCategory({ name: trimmed, kind, color_slot: colorSlot, icon, space_id: spaceId });
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

  function saveEdit() {
    if (!editing) return;
    const trimmed = editing.name.trim();
    if (!trimmed) {
      setEditError("Name is required");
      return;
    }
    setEditError(null);
    startSave(async () => {
      const res = await updateCategory({
        id: editing.id,
        name: trimmed,
        color_slot: editing.colorSlot,
        icon: editing.icon,
      });
      if ("error" in res) {
        setEditError(res.error);
        return;
      }
      // Patched into local state rather than left to the revalidate: the
      // server action does revalidatePath("/", "layout"), but this list is
      // client state seeded once from `initial`, so without this the row
      // would keep its old name until a navigation.
      setItems((prev) =>
        prev.map((c) =>
          c.id === editing.id
            ? { ...c, name: trimmed, color_slot: editing.colorSlot, icon: editing.icon }
            : c,
        ),
      );
      setEditing(null);
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
              {/* The row's own name is the edit affordance, matching how a
                  transaction row opens its edit screen. Accessible name is
                  "Edit <name>", which CONTAINS the visible text (WCAG 2.5.3
                  Label in Name) while still saying what pressing it does —
                  a button announced as bare "Groceries" says neither. */}
              <button
                type="button"
                onClick={() => {
                  setEditError(null);
                  setEditing({
                    id: c.id,
                    originalName: c.name,
                    name: c.name,
                    colorSlot: c.color_slot,
                    icon: (c.icon as CategoryIcon) in CATEGORY_ICON_COMPONENTS
                      ? (c.icon as CategoryIcon)
                      : "circle",
                  });
                }}
                aria-label={`Edit ${c.name}`}
                className={`flex-1 truncate rounded-sm text-left ${FOCUS_RING}`}
                style={{ color: "var(--ink)" }}
              >
                {c.name}
              </button>
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

        <ColourPicker
          groupName={`${kind}-color-slot`}
          value={colorSlot}
          onChange={setColorSlot}
        />

        <IconPicker groupName={`${kind}-icon`} value={icon} onChange={setIcon} />

        <button
          type="submit"
          disabled={creating}
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

      {/* ONE dialog for the list, not one per row — the same reasoning
          WalletList.tsx documents: a Modal inside every <li> would mount a
          focus trap and a keydown handler per category when only one can be
          open. Titled with the name captured at open time, so a screen
          reader is told which category is being changed even though the row
          behind it is now covered. */}
      {editing && (
        <Modal open title={`Edit ${editing.originalName}`} onClose={() => setEditing(null)}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              saveEdit();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-xs" style={{ color: "var(--ink-2)" }}>
                Name
              </span>
              <input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                maxLength={40}
                autoComplete="off"
                aria-describedby={editError ? editErrorId : undefined}
                className={`rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
                style={{
                  borderColor: "var(--ink-2)",
                  background: "var(--surface)",
                  color: "var(--ink)",
                }}
              />
            </label>

            {/* Distinct radio-group names from the add form's, which is still
                mounted behind this dialog — sharing a name would make a
                choice here clear the one below. */}
            <ColourPicker
              groupName={`${kind}-edit-color-slot`}
              value={editing.colorSlot}
              onChange={setEditColour}
            />
            <IconPicker
              groupName={`${kind}-edit-icon`}
              value={editing.icon}
              onChange={setEditIcon}
            />

            {/* Kind and wallet are absent rather than shown disabled — this
                codebase's convention for a control that could never succeed.
                Neither is editable: 0018_category_update_grant.sql revokes
                the column privilege for both, and changing a category's kind
                would leave every transaction filed under it holding a
                mismatched category, which updateTransaction then refuses. */}
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={saving}
                className={`rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
                style={{ background: "var(--cat-1)", color: "var(--surface)" }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className={`rounded-md px-3 py-2 text-sm ${FOCUS_RING}`}
                style={{ color: "var(--ink-2)" }}
              >
                Cancel
              </button>
            </div>

            {/* Always mounted, same reasoning as the add form's alert. */}
            <p id={editErrorId} role="alert" className="text-sm" style={{ color: "var(--neg)" }}>
              {editError}
            </p>
          </form>
        </Modal>
      )}
    </section>
  );
}


/**
 * The colour and icon pickers, lifted out of the add form so the edit dialog
 * renders the SAME controls rather than a second copy that drifts. Both take
 * their radio-group `name` from the caller: the add form and an open edit
 * dialog are on the page at once, and two radio groups sharing a name would
 * make choosing a colour in the dialog silently clear the one in the form
 * beneath it.
 */
function ColourPicker({
  groupName,
  value,
  onChange,
}: {
  groupName: string;
  value: number;
  onChange: (slot: number) => void;
}) {
  return (
        <fieldset>
        <legend className="text-xs" style={{ color: "var(--ink-2)" }}>
        Colour
        </legend>
        <div className="mt-1 flex flex-wrap gap-2">
        {SLOTS.map((slot) => {
          const selected = value === slot;
          return (
            <label key={slot} className="cursor-pointer">
              <input
                type="radio"
                name={groupName}
                value={slot}
                checked={selected}
                onChange={() => onChange(slot)}
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
  );
}

/**
 * Memoised, and not as a micro-optimisation. Without this every keystroke in
 * the name field above re-renders all 132 icon buttons, which made typing
 * measurably slow in tests and would be worse on a phone. `onChange` must
 * therefore be referentially stable at both call sites, or the memo does
 * nothing — the add form passes `setIcon` (stable by definition) and the
 * edit dialog passes a `useCallback` with a functional state update.
 */
const IconPicker = memo(function IconPicker({
  groupName,
  value,
  onChange,
}: {
  groupName: string;
  value: CategoryIcon;
  onChange: (icon: CategoryIcon) => void;
}) {
  return (
        <fieldset>
        <legend className="text-xs" style={{ color: "var(--ink-2)" }}>
        Icon
        </legend>
        {/* Grouped and scroll-bounded rather than one flat wrap row. At 17
          icons a single row was fine; at 132 it is a wall of glyphs
          several screens tall on a phone, which pushes the Add button
          out of reach — the control the user came here to press. The
          groups are a partition of CATEGORY_ICONS, proven at import
          time in src/lib/category-icons.ts, so nothing the schema
          accepts can be missing from this list.

          One radio group across all sections (every input shares
          `${kind}-icon`), so arrow keys still traverse the whole set
          and only one icon can be chosen — the headings are visual
          grouping, not separate controls. */}
        <div
        className="mt-1 max-h-56 overflow-y-auto rounded-md border p-2"
        style={{ borderColor: "var(--grid)" }}
        >
        {CATEGORY_ICON_GROUPS.map((group) => (
          <div key={group.label} className="mb-3 last:mb-0">
            {/* var(--ink-2), not var(--muted): at 11px this is body-size
                text and needs 4.5:1. --muted on --surface measures 3.49:1
                in light mode (axe, CI's accessibility gate); --ink-2
                measures 7.73:1 light / 9.72:1 dark (TabBar's own numbers). */}
            <p
              className="mb-1 text-[11px] font-medium uppercase tracking-wide"
              style={{ color: "var(--ink-2)" }}
            >
              {group.label}
            </p>
            <div className="flex flex-wrap gap-2">
              {group.icons.map((iconName) => {
                const Icon = CATEGORY_ICON_COMPONENTS[iconName];
                const selected = value === iconName;
                return (
                  <label key={iconName} className="cursor-pointer">
                    <input
                      type="radio"
                      name={groupName}
                      value={iconName}
                      checked={selected}
                      onChange={() => onChange(iconName)}
                      className="peer sr-only"
                      aria-label={iconName.replace(/-/g, " ")}
                    />
                    {/* Same mitigation shape as src/components/shell/
                        Sidebar.tsx's active-nav-item indicator
                        (border-left colour change plus a second cue —
                        there font-weight, here the icon's own stroke
                        colour), not the background-alone approach that
                        failed elsewhere on this branch. var(--cat-1)
                        measures 5.60:1 (light) / 5.20:1 (dark) against
                        var(--surface); var(--ink-2) (unselected)
                        measures 7.73:1 / 9.72:1. */}
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
          </div>
        ))}
        </div>
      </fieldset>
  );
});
