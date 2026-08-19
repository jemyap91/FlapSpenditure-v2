import { formatMoney } from "@/lib/money";

/**
 * One row of `get_cash_flow`'s result (supabase/migrations/0006_aggregates.sql).
 * `bucket_start` is a plain SQL `date` (`date_trunc(bucket, t.occurred_on)::date`),
 * never a timestamp, so Supabase serialises it as a bare "YYYY-MM-DD" string with
 * no time-zone component to round-trip through — unlike `page.tsx`'s `monthRange`,
 * nothing here ever constructs a `Date` object from it. `in_minor` and `out_minor`
 * are BOTH already positive magnitudes — the RPC computes
 * `sum(t.amount_minor) filter (where amount_minor > 0)` and
 * `sum(-t.amount_minor) filter (where amount_minor < 0)` server-side — so neither
 * is negated again here; only the chart's LAYOUT (which half of the baseline a
 * bar grows into) expresses the sign, never the stored number.
 *
 * Per spec §3.3 ("category and income/expense rollups filter `kind <> 'transfer'`;
 * cash flow does not"), `get_cash_flow` applies no `kind` filter — a transfer's two
 * legs land in `in_minor`/`out_minor` on their respective wallets/buckets exactly
 * like an income or expense would. Nothing in this component re-applies a filter
 * that would contradict that.
 */
export type FlowRow = { bucket_start: string; in_minor: number; out_minor: number };

/** Pixel height of ONE side of the baseline (the "in" half and the "out" half
 * are each scaled independently against the same `maxMagnitude`, so a day's
 * in-bar and out-bar are directly comparable to each other AND to every other
 * bucket's bars — one shared scale, not one scale per bucket). */
const HALF_HEIGHT = 88;

/** Sub-pixel/zero-height floor, same reasoning as `CategoryBreakdown`'s 2px
 * segment floor: a real, nonzero flow on a low-activity bucket must stay
 * visible rather than getting rounded away to nothing. A bucket with a true
 * zero (no inflow, or no outflow, that period) renders no bar at all on that
 * side — that absence IS the correct information, not something to pad. */
export const MIN_BAR_PX = 2;

export function barHeight(magnitude: number, maxMagnitude: number): number {
  if (magnitude <= 0) return 0;
  return Math.max(MIN_BAR_PX, (magnitude / maxMagnitude) * HALF_HEIGHT);
}

/**
 * One shared scale across every bucket and BOTH directions, so a day's
 * in-bar and out-bar — and every other bucket's bars — are all drawn against
 * the same yardstick (review-caught, Important: stronger than the brief's
 * own sample, which didn't specify this). `Math.max(1, ...)` guards only the
 * degenerate all-zero case: without it, a month with literally no flow would
 * divide by zero inside `barHeight` and turn every height into `NaN`/`Infinity`
 * rather than the `0` an all-quiet month should render. Exported so this
 * guard is unit-testable without rendering the whole component.
 */
export function computeMaxMagnitude(rows: readonly FlowRow[]): number {
  return Math.max(1, ...rows.flatMap((r) => [r.in_minor, r.out_minor]));
}

/**
 * `formatMoney({ signed: true })` renders `0` as `"+$0.00"` — correct for
 * `TransactionList.tsx`'s use (an already-signed `amount_minor` that is
 * genuinely never exactly zero there) but wrong here: an exactly-balanced
 * bucket (`in === out`, e.g. a transfer's two legs landing in the same
 * bucket) has not "gained" anything and shouldn't read as if it had.
 * Review-caught (small). Deliberately NOT fixed in `src/lib/money.ts` —
 * three other tasks depend on its existing sign behaviour — so the zero
 * case is special-cased at this one call site instead.
 */
function formatNet(netMinor: number, currencyCode: string): string {
  return netMinor === 0 ? formatMoney(0, currencyCode) : formatMoney(netMinor, currencyCode, { signed: true });
}

export function CashFlow({
  rows,
  currencyCode,
  hasExcludedWallets = false,
}: {
  rows: FlowRow[];
  currencyCode: string;
  /**
   * Mirrors `page.tsx`'s own `hasExcludedWallets` (Task 21, REVIEW-CAUGHT
   * Important): the hero total already discloses when non-primary-currency
   * wallets are silently excluded from `wallet_ids`. This chart is built
   * from the SAME `wallet_ids`, so it's subject to the identical omission —
   * without this, a mixed-currency user reads a full month of in/out
   * figures with the qualifier several hundred pixels away on the hero and
   * no indication THIS chart is scoped the same way. Optional (defaults to
   * `false`) so existing callers/tests that don't pass it still compile.
   */
  hasExcludedWallets?: boolean;
}) {
  if (!rows.length) {
    return (
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        No cash flow recorded this month.
      </p>
    );
  }

  const maxMagnitude = computeMaxMagnitude(rows);

  return (
    <section aria-labelledby="flow-heading" className="flex flex-col gap-4">
      <div>
        <h2
          id="flow-heading"
          className="text-sm font-medium uppercase tracking-wide"
          style={{ color: "var(--ink-2)" }}
        >
          Cash flow
        </h2>
        {/* Same disclosure convention as the hero caption in `page.tsx`:
            unqualified in the common case (every active wallet shares one
            currency), qualified whenever some were excluded. */}
        {hasExcludedWallets && (
          <p className="text-xs" style={{ color: "var(--ink-2)" }}>
            {currencyCode} wallets only
          </p>
        )}
      </div>

      {/* Text legend, not a colour-only cue: "In"/"Out" are stated in words,
          so a viewer who can't distinguish teal from rust (spec §6.2's whole
          reason for choosing this pairing over green/red) still has the
          labels; the swatches are a decorative reinforcement (aria-hidden),
          not the only source of the label. */}
      <div className="flex items-center gap-4 text-xs" style={{ color: "var(--ink-2)" }}>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--div-in)" }} />
          In
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--div-out)" }} />
          Out
        </span>
      </div>

      {/*
        Hand-rolled, like `CategoryBreakdown` — see this task's report for why
        Recharts isn't pulled in here either. Two coloured bars per bucket,
        split into a top ("in") half and a bottom ("out") half around a zero
        baseline, is exactly as achievable with plain flex/percentage-height
        `<div>`s as the breakdown's stacked bar was — keeping this a Server
        Component (no client JS shipped for this chart at all) and getting
        the same accessibility primitives (a hover tooltip, a real `<table>`
        twin below) without a chart library's own SVG/ARIA gaps to patch.

        Polarity is conveyed STRUCTURALLY — which half of the baseline a bar
        occupies — not only by colour (spec §6.5: "money above and below a
        zero baseline is polarity"), so a CVD viewer who can't tell teal from
        rust still reads "in" vs "out" from position alone; the two hues are a
        second, deliberately cool/warm-opposite cue layered on top (§6.2), not
        the only one. `role="img"` + a full aria-label follows the same
        pattern `CategoryBreakdown` established for its stacked bar.

        REVIEW-CAUGHT (Important): position is only legible relative to a
        baseline the viewer can actually see. The first version drew a 2px
        `--div-mid` rule INSIDE each column, which — combined with the
        columns' own `gap-[2px]` — rendered as a DASHED line (10px on, 2px
        off per bucket), and only existed under the columns that happened to
        render (three buckets = three short dashes at the left edge, not a
        line spanning the chart). Spec §6.5 says gridlines are "never
        dashed." Worse, a bucket with only an out-bar (no in-bar to visually
        meet it) had nothing at all to anchor "below what" against except the
        rust bar's own top edge. Fixed by drawing ONE continuous 2px rule,
        absolutely positioned across the full (scrollable) width of this
        `relative` container, independent of how many columns exist or what
        they contain — load-bearing for exactly the one-sided-bucket case
        above.
      */}
      <div
        role="img"
        aria-label={`Cash flow by period: ${rows
          .map(
            (r) =>
              `${r.bucket_start}, in ${formatMoney(r.in_minor, currencyCode)}, out ${formatMoney(r.out_minor, currencyCode)}`,
          )
          .join("; ")}`}
        tabIndex={0}
        className="relative flex items-stretch gap-[2px] overflow-x-auto"
        style={{ height: HALF_HEIGHT * 2 + 2 }}
      >
        {/* The single continuous baseline rule — see the doc comment above.
            Positioned at the exact seam between the top/bottom halves,
            spanning the container's full content width (which grows with
            the scrollable content, not just the visible viewport), so it's
            present under every column including ones with only an in- or
            only an out-bar. */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: HALF_HEIGHT,
            height: 2,
            background: "var(--div-mid)",
          }}
        />
        {rows.map((r) => {
          const inPx = barHeight(r.in_minor, maxMagnitude);
          const outPx = barHeight(r.out_minor, maxMagnitude);
          return (
            <div
              key={r.bucket_start}
              className="flex flex-shrink-0 flex-col"
              style={{ width: 10, minWidth: 10 }}
            >
              {/* Top half: bottom-anchored, so the "in" bar grows UPWARD away
                  from the baseline as its value increases. `title` sits on
                  this whole half (10x88px), not the (possibly 2px-tall) bar
                  itself — review-caught (small): a hover target as small as
                  10x2px falls well short of spec §6.5's ~24px hit-area
                  guidance for a low-magnitude bucket. */}
              <div
                title={`${r.bucket_start}: in ${formatMoney(r.in_minor, currencyCode)}`}
                className="flex flex-col justify-end"
                style={{ height: HALF_HEIGHT }}
              >
                <div
                  style={{
                    height: inPx,
                    background: "var(--div-in)",
                    borderRadius: "2px 2px 0 0",
                  }}
                />
              </div>
              {/* 2px spacer reserving the same visual gap the old per-column
                  baseline occupied — purely structural now (no background of
                  its own); the absolutely-positioned rule above supplies the
                  actual colour, once, for the whole chart. */}
              <div aria-hidden style={{ height: 2 }} />
              {/* Bottom half: top-anchored, so the "out" bar grows DOWNWARD
                  away from the baseline as its value increases. */}
              <div
                title={`${r.bucket_start}: out ${formatMoney(r.out_minor, currencyCode)}`}
                className="flex flex-col justify-start"
                style={{ height: HALF_HEIGHT }}
              >
                <div
                  style={{
                    height: outPx,
                    background: "var(--div-out)",
                    borderRadius: "0 0 2px 2px",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/*
        The non-colour, non-pointer twin (spec §6.5): every bucket the RPC
        returned, in the SAME chronological order the bar draws them, with an
        explicit signed "Net" column so the polarity the bar shows spatially
        is also stated as a number. `in`/`out` stay unsigned (they're already
        positive magnitudes labelled by column header, matching
        `CategoryBreakdown`'s convention for its own always-positive amounts);
        `net` uses `formatNet` (see its doc comment above for why a plain
        `formatMoney(..., { signed: true })` isn't quite right at exactly
        zero).
      */}
      <table className="w-full text-sm">
        <caption className="sr-only">Cash flow by period</caption>
        <thead>
          <tr>
            <th scope="col" className="sr-only">
              Period
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium" style={{ color: "var(--ink-2)" }}>
              In
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium" style={{ color: "var(--ink-2)" }}>
              Out
            </th>
            <th scope="col" className="py-1.5 text-right font-medium" style={{ color: "var(--ink-2)" }}>
              Net
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const net = r.in_minor - r.out_minor;
            return (
              <tr key={r.bucket_start} style={{ borderTop: "1px solid var(--grid)" }}>
                <td className="py-1.5 pr-3" style={{ color: "var(--ink)" }}>
                  {r.bucket_start}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                  {formatMoney(r.in_minor, currencyCode)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                  {formatMoney(r.out_minor, currencyCode)}
                </td>
                <td className="py-1.5 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                  {formatNet(net, currencyCode)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
