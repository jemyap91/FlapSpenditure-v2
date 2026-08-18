import { formatMoney } from "@/lib/money";
import { slotVar, SLOT_COUNT } from "@/lib/palette";
import { CATEGORY_ICON_COMPONENTS } from "@/lib/category-icons";
import type { CategoryIcon } from "@/lib/validation/category";

/**
 * One row of `get_category_breakdown`'s result (supabase/migrations/
 * 0006_aggregates.sql). `total_minor` is already a POSITIVE magnitude —
 * the RPC computes `sum(-t.amount_minor)` server-side (expenses are stored
 * negative) — so nothing here negates it again. `icon` is carried (the
 * RPC returns it) so a row can show the same icon+colour+name identity
 * `TransactionList.tsx`/`CategoryPicker.tsx` already use, not a bare
 * colour dot: spec §6.1 says colour alone stops being unique past 8
 * categories ("category nine onward reuses slots and relies on its icon
 * and name for identity"), so colour is never the only cue here either.
 */
export type BreakdownRow = {
  category_id: string;
  name: string;
  color_slot: number;
  icon: string;
  total_minor: number;
};

/**
 * Stacked-bar segment cap, before the tail folds into "Other" (spec §6.5:
 * "a stacked bar plus a ranked list, not a donut"). Set to `SLOT_COUNT`
 * (8), not an arbitrary smaller number: spec §6.1's own words are "eight
 * is the ceiling" for the whole colour system — a ninth generated hue is
 * indistinguishable under colour-vision deficiency, which is exactly why
 * `color_slot` only ever ranges 1-8 and category nine onward (by creation
 * order) already reuses a slot. Capping the BAR at that same ceiling
 * means it never shows more individually-coloured segments than the
 * palette can actually tell apart, and the "Other" fold only ever
 * activates once a real 9th-or-later category (by spend, this RPC's own
 * `order by 5 desc`) would otherwise need a repeated hue.
 *
 * This is not a collision *guarantee* — two of the top 8 BY SPEND can
 * already share a `color_slot` if the caller owns more than 8 categories
 * total (slots are assigned at category creation, independent of spend
 * rank), and the spec explicitly accepts that ("relies on its icon and
 * name for identity"). That is exactly why the ranked list below is never
 * folded and always pairs colour with icon + name: it is the fallback
 * that keeps two same-hue segments distinguishable, not a decoration.
 */
const TOP_N = SLOT_COUNT;

export function CategoryBreakdown({
  rows,
  currencyCode,
}: {
  rows: BreakdownRow[];
  currencyCode: string;
}) {
  if (!rows.length) {
    return (
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        No spending recorded this month.
      </p>
    );
  }

  const total = rows.reduce((s, r) => s + r.total_minor, 0);
  const top = rows.slice(0, TOP_N);
  const tail = rows.slice(TOP_N);
  const tailTotal = tail.reduce((s, r) => s + r.total_minor, 0);
  // Segments are what the BAR draws — folded past TOP_N. The table below
  // maps over `rows` directly (never `segments`), so every individual
  // category (including everything folded into "Other" here) still gets
  // its own real amount, icon, colour and name — the bar simplifies,
  // the list never does.
  const segments =
    tailTotal > 0
      ? [
          ...top,
          {
            category_id: "other",
            name: `Other (${tail.length} ${tail.length === 1 ? "category" : "categories"})`,
            color_slot: 0,
            icon: "circle-ellipsis",
            total_minor: tailTotal,
          },
        ]
      : top;

  return (
    <section aria-labelledby="breakdown-heading" className="flex flex-col gap-4">
      <h2
        id="breakdown-heading"
        className="text-sm font-medium uppercase tracking-wide"
        style={{ color: "var(--ink-2)" }}
      >
        Spending by category
      </h2>

      {/*
        role="img" + a full-text aria-label: a screen-reader user gets the
        whole bar's content in one announcement rather than needing to
        find and step through unlabelled child <span>s. This is a
        SUPPLEMENT to the table below, not the only accessible path to the
        data — the table conveys everything (and, for the tail, MORE:
        every individual category the bar folds into "Other").
        2px gaps between segments (via margin, not border) keep same-hue
        neighbours visually separated (§6.5) without adding a border
        colour that would itself need a contrast check.
      */}
      <div
        className="flex h-4 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={`Spending by category: ${segments
          .map((s) => `${s.name}, ${formatMoney(s.total_minor, currencyCode)}`)
          .join("; ")}`}
      >
        {segments.map((s, i) => (
          <span
            key={s.category_id}
            style={{
              width: `${(s.total_minor / total) * 100}%`,
              // Real categories: colour follows THIS row's own stored
              // color_slot, never by rank/position — the RPC's `order by`
              // changes with the date range or the data, but a given
              // category's slot never does (spec §6.1: "colour follows the
              // category permanently, assigned at creation, and never
              // repaints when a filter changes what is on screen").
              // "Other" (color_slot 0, synthetic) is not a real category
              // and never was assigned a slot, so it gets a neutral,
              // non-categorical fill instead of borrowing one — var(--muted)
              // is used here as a decorative, non-text swatch (WCAG
              // 1.4.11's 3:1 floor, not 1.4.3's 4.5:1 for text), which it
              // clears against both var(--surface) and var(--page) in both
              // themes (see this task's report's contrast table).
              background: s.color_slot ? slotVar(s.color_slot) : "var(--muted)",
              marginLeft: i === 0 ? 0 : 2,
            }}
          />
        ))}
      </div>

      {/*
        The full ranked list — every row `get_category_breakdown` returned,
        NEVER folded (unlike the bar above). This is the non-colour,
        non-pointer path to the same data the bar draws, plus the
        individual detail the bar's own "Other" segment necessarily hides.
      */}
      <table className="w-full text-sm">
        <caption className="sr-only">Spending by category, highest first</caption>
        <thead>
          <tr>
            <th scope="col" className="sr-only">
              Category
            </th>
            <th scope="col" className="sr-only">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const Icon =
              CATEGORY_ICON_COMPONENTS[r.icon as CategoryIcon] ?? CATEGORY_ICON_COMPONENTS.circle;
            const pct = total > 0 ? Math.round((r.total_minor / total) * 100) : 0;
            return (
              <tr key={r.category_id} style={{ borderTop: "1px solid var(--grid)" }}>
                <td className="py-1.5">
                  <span className="flex items-center gap-2">
                    <Icon aria-hidden size={16} style={{ color: slotVar(r.color_slot) }} className="shrink-0" />
                    <span style={{ color: "var(--ink)" }}>{r.name}</span>
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                  {formatMoney(r.total_minor, currencyCode)}
                  <span className="ml-2" style={{ color: "var(--ink-2)" }}>
                    {pct}%
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
