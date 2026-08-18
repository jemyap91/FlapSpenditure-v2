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
const MIN_BAR_PX = 2;

function barHeight(magnitude: number, maxMagnitude: number): number {
  if (magnitude <= 0) return 0;
  return Math.max(MIN_BAR_PX, (magnitude / maxMagnitude) * HALF_HEIGHT);
}

export function CashFlow({ rows, currencyCode }: { rows: FlowRow[]; currencyCode: string }) {
  if (!rows.length) {
    return (
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        No cash flow recorded this month.
      </p>
    );
  }

  // One shared scale across every bucket and both directions — `Math.max(1, ...)`
  // only guards the degenerate case where every row is exactly zero (division by
  // zero would otherwise turn every bar height into NaN, not 0).
  const maxMagnitude = Math.max(1, ...rows.flatMap((r) => [r.in_minor, r.out_minor]));

  return (
    <section aria-labelledby="flow-heading" className="flex flex-col gap-4">
      <h2
        id="flow-heading"
        className="text-sm font-medium uppercase tracking-wide"
        style={{ color: "var(--ink-2)" }}
      >
        Cash flow
      </h2>

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
        Recharts (present in package.json, unused so far) isn't pulled in here
        either. Two coloured bars per bucket, split into a top ("in") half and
        a bottom ("out") half around a zero baseline, is exactly as achievable
        with plain flex/percentage-height `<div>`s as the breakdown's stacked
        bar was — keeping this a Server Component (no client JS shipped for
        this chart at all) and getting the same accessibility primitives (a
        native `title` per bar, a real `<table>` twin below) without a chart
        library's own SVG/ARIA gaps to patch.

        Polarity is conveyed STRUCTURALLY — which half of the baseline a bar
        occupies — not only by colour (spec §6.5: "money above and below a
        zero baseline is polarity"), so a CVD viewer who can't tell teal from
        rust still reads "in" vs "out" from position alone; the two hues are a
        second, deliberately cool/warm-opposite cue layered on top (§6.2), not
        the only one. `role="img"` + a full aria-label follows the same
        pattern `CategoryBreakdown` established for its stacked bar: one
        announcement carries the whole chart's content for a screen-reader
        user, in addition to (not instead of) the table below and each bar's
        own `title`.
      */}
      <div
        role="img"
        aria-label={`Cash flow by period: ${rows
          .map(
            (r) =>
              `${r.bucket_start}, in ${formatMoney(r.in_minor, currencyCode)}, out ${formatMoney(r.out_minor, currencyCode)}`,
          )
          .join("; ")}`}
        className="flex items-stretch gap-[2px] overflow-x-auto"
        style={{ height: HALF_HEIGHT * 2 + 2 }}
      >
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
                  from the baseline as its value increases. */}
              <div className="flex flex-col justify-end" style={{ height: HALF_HEIGHT }}>
                <div
                  title={`${r.bucket_start}: in ${formatMoney(r.in_minor, currencyCode)}`}
                  style={{
                    height: inPx,
                    background: "var(--div-in)",
                    borderRadius: "2px 2px 0 0",
                  }}
                />
              </div>
              {/* The zero baseline itself. `--div-mid` is the spec's own
                  third diverging colour (§6.2's "neutral grey midpoint"), so
                  it's used here rather than `--grid`/`--muted` even though —
                  see this task's report — its contrast against `--page` is
                  low in both themes: it is a structural marker (the boundary
                  between the two already-labelled, already-positioned
                  halves), not the sole carrier of any information a viewer
                  couldn't already get from which half a bar is in. */}
              <div style={{ height: 2, background: "var(--div-mid)" }} />
              {/* Bottom half: top-anchored, so the "out" bar grows DOWNWARD
                  away from the baseline as its value increases. */}
              <div className="flex flex-col justify-start" style={{ height: HALF_HEIGHT }}>
                <div
                  title={`${r.bucket_start}: out ${formatMoney(r.out_minor, currencyCode)}`}
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
        `net` uses `formatMoney`'s `signed` option — the same one
        `TransactionList.tsx` uses for its already-signed `amount_minor` — since
        net flow genuinely can be positive or negative and that sign is the
        point of the column.
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
                  {formatMoney(net, currencyCode, { signed: true })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
