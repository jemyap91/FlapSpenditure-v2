import { formatMoney } from "@/lib/money";
import { slotVar } from "@/lib/palette";
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
 * A bar/table entry — the shape both `segments` (the bar, possibly folded)
 * and `rows` (the table, never folded) are rendered from. `color_slot: 0`
 * marks the synthetic "Other" bucket, which is not a real category and was
 * never assigned a slot — it renders with `var(--muted)` instead (see the
 * bar's `background` below), never by borrowing a real category's colour.
 */
type Entry = {
  category_id: string;
  name: string;
  color_slot: number;
  icon: string;
  total_minor: number;
};

/**
 * Stacked-bar segment cap, before the tail folds into "Other" (spec §6.5:
 * "top 6 categories plus 'Other'"). Matches the spec's literal number.
 *
 * REVIEW-CAUGHT (Important): an earlier version of this file set
 * `TOP_N = SLOT_COUNT` (8), reasoning from §6.1's "eight is the ceiling."
 * That reasoning pointed at the wrong guarantee. §6.1's ceiling is about
 * how many hues EXIST; `scripts/validate-palette.mjs`'s CVD/contrast
 * checks only ever certify ADJACENT slots (slot *i* vs slot *i+1*) — it
 * never checks arbitrary pairs like slot 4 vs slot 6. Under the
 * validator's own Machado-2009 simulation, slot 4 and slot 6 are barely
 * distinguishable even to NORMAL vision (ΔE ~3, OKLab×100 — reviewer-
 * measured) and nearly identical under deuteranopia (ΔE ~0.2-0.3). Because
 * the bar draws segments in SPEND order (not slot order) by default, any
 * two visible categories can end up neighbours regardless of how far apart
 * their slots are — raising the cap to 8 only widened how often a
 * non-adjacent, barely-distinguishable pair like 4-and-6 could land side
 * by side. Restored to 6, the spec's own number.
 */
const TOP_N = 6;

/**
 * Builds what the BAR draws: the top `TOP_N` rows (by the RPC's own spend
 * ordering) plus one synthetic "Other" entry for everything past that, if
 * anything is. Exported for testing the fold boundary and pluralisation in
 * isolation from rendering.
 */
export function buildSegments(rows: readonly BreakdownRow[], topN: number = TOP_N): Entry[] {
  const top = rows.slice(0, topN);
  const tail = rows.slice(topN);
  const tailTotal = tail.reduce((s, r) => s + r.total_minor, 0);

  // Mitigation for the Important finding above: sort the BAR's own visible
  // real-category segments by `color_slot` ascending (the ranked TABLE
  // below stays spend-ordered — untouched by this). Consecutive slot
  // numbers are exactly the pairs `validate-palette.mjs` certifies as
  // CVD-distinguishable; sorting the visible set by slot maximises how
  // often two adjacent bar segments are actually a validator-certified
  // consecutive pair instead of an arbitrary, possibly near-identical one
  // like 4-and-6.
  //
  // This is a mitigation, not a guarantee: if the visible set skips a slot
  // (e.g. the top 6 categories happen to use slots {1,2,4,6,7,8}, with no
  // 3 or 5 present), the sorted bar still places slot 4 directly next to
  // slot 6 — the exact near-identical pair this fix exists to avoid —
  // because `validate-palette.mjs` never certified that specific
  // non-consecutive gap-adjacency at all; it only ever checks a FULL
  // 8-slot run. Two categories can also share the identical `color_slot`
  // outright once the caller owns more than 8 categories total (slots are
  // assigned at creation, independent of spend rank) — sorting groups
  // those together rather than separating them, which is correct: they
  // ARE the same colour, and the ranked list's icon + name (never
  // reordered, never folded) is the always-correct disambiguator for
  // exactly this case, not a decoration.
  const sortedTop = [...top].sort((a, b) => a.color_slot - b.color_slot);

  if (tailTotal <= 0) return sortedTop;
  return [
    ...sortedTop,
    {
      category_id: "other",
      name: `Other (${tail.length} ${tail.length === 1 ? "category" : "categories"})`,
      color_slot: 0,
      icon: "circle-ellipsis",
      total_minor: tailTotal,
    },
  ];
}

/** Rounded whole-percent share of `total` — for display text only (the bar
 * and per-row mini-bars use the exact fractional width, not this rounded
 * figure, so a rounding artefact never visibly misstates a bar's length). */
export function pctOf(amount: number, total: number): number {
  return total > 0 ? Math.round((amount / total) * 100) : 0;
}

export function CategoryBreakdown({
  rows,
  currencyCode,
  total,
}: {
  rows: BreakdownRow[];
  currencyCode: string;
  /** Sum of every row's `total_minor` — passed down by the caller (which
   * already computes it once for the hero figure) rather than re-derived
   * here a second time. Two independent sums of the same array can only
   * ever agree by construction, never by a guarantee (review-caught); a
   * single source of truth means the hero and this bar cannot disagree. */
  total: number;
}) {
  if (!rows.length) {
    return (
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        No spending recorded this month.
      </p>
    );
  }

  const segments = buildSegments(rows);

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
        every individual category the bar folds into "Other"). Each
        segment ALSO carries a native `title` attribute (review-caught,
        Important: §6.5 requires a crosshair/per-mark tooltip in addition
        to the table twin — hovering used to reveal nothing) so a mouse
        user gets the same per-segment name+amount a screen-reader user
        already got from the aria-label, without any client JS.
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
            title={`${s.name}: ${formatMoney(s.total_minor, currencyCode)}`}
            style={{
              width: `${(s.total_minor / total) * 100}%`,
              // REVIEW-CAUGHT (small): a category under ~1% of the total
              // rendered at a sub-pixel width, which the flex row's default
              // `flex-shrink` then silently rescaled away entirely —
              // effectively deleting a real, nonzero-spend category from
              // the bar with no visual trace. A 2px floor keeps every
              // segment (including "Other") visible regardless of share.
              minWidth: "2px",
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
        NEVER folded (unlike the bar above) and always in SPEND order (the
        bar's slot-sorted segments above do not affect this). This is the
        non-colour, non-pointer path to the same data the bar draws, plus
        the individual detail the bar's own "Other" segment necessarily
        hides. Each row also carries its own mini bar (review-caught,
        Important: §6.5 specifies "colour chip, name, bar, exact amount" —
        the % text alone wasn't the bar) sized from the SAME `total` the
        hero and the big bar use, coloured from the SAME `color_slot` as
        everywhere else, so "is Groceries or Transport bigger" is answered
        pre-attentively by bar length, not by comparing two numbers.
      */}
      <table className="w-full text-sm">
        <caption className="sr-only">Spending by category, highest first</caption>
        <thead>
          <tr>
            <th scope="col" className="sr-only">
              Category
            </th>
            <th scope="col" className="sr-only">
              Share
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
            const pct = pctOf(r.total_minor, total);
            return (
              <tr key={r.category_id} style={{ borderTop: "1px solid var(--grid)" }}>
                <td className="py-1.5 pr-3">
                  <span className="flex items-center gap-2">
                    <Icon aria-hidden size={16} style={{ color: slotVar(r.color_slot) }} className="shrink-0" />
                    <span style={{ color: "var(--ink)" }}>{r.name}</span>
                  </span>
                </td>
                <td className="py-1.5 pr-3" style={{ width: "30%" }}>
                  <div
                    className="h-2 w-full overflow-hidden rounded-full"
                    style={{ background: "var(--grid)" }}
                  >
                    <div
                      style={{
                        width: `${(r.total_minor / total) * 100}%`,
                        minWidth: "2px",
                        height: "100%",
                        background: slotVar(r.color_slot),
                      }}
                    />
                  </div>
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
