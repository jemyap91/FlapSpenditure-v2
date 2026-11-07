import Link from "next/link";
import { formatMoney } from "@/lib/money";
import { MONTH_ABBREV } from "@/lib/month-names";
import type { CardTrackerRow } from "@/server/card-tracker";

const LINK_CLASS =
  "rounded-sm text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/** Fill colour per pace; the status text beside the bar carries the same state. */
const FILL: Record<CardTrackerRow["pace"], string> = {
  under: "var(--cat-3)",
  on_pace: "var(--cat-2)",
  reached: "var(--pos)",
};

// Day and month read from the string's own digits, never a `Date` (see `month-names.ts`).
const day = (iso: string) => Number(iso.slice(8, 10));
const month = (iso: string) => MONTH_ABBREV[Number(iso.slice(5, 7)) - 1];

/** "19 Oct–18 Nov", or "1–30 Nov" when the cycle sits inside one month. */
function cycleLabel(from: string, to: string): string {
  if (from.slice(0, 7) === to.slice(0, 7)) return `${day(from)}–${day(to)} ${month(to)}`;
  return `${day(from)} ${month(from)}–${day(to)} ${month(to)}`;
}

/** Activity showing exactly the expenses behind a row's spent figure. */
function countedHref(row: CardTrackerRow): string {
  const channel = row.bonusChannel ? `&channel=${row.bonusChannel}` : "";
  return `/transactions?wallet=${row.walletId}&expenses=1${channel}&from=${row.from}&to=${row.to}`;
}

/**
 * Home's "Card bonus" section (spec 4.6): one row per card with a max or min spend,
 * measured over the cycle `loadCardTracker` resolved. Renders nothing when no
 * card has either, so Home shows no empty chrome.
 */
export function CardTracker({ rows }: { rows: CardTrackerRow[] }) {
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="card-bonus-heading" className="flex flex-col gap-4">
      <h2
        id="card-bonus-heading"
        className="text-sm font-medium uppercase tracking-wide"
        style={{ color: "var(--ink-2)" }}
      >
        Card bonus
      </h2>
      {rows.map((row) => (
        <CardTrackerItem key={row.walletId} row={row} />
      ))}
    </section>
  );
}

function CardTrackerItem({ row }: { row: CardTrackerRow }) {
  // The bar and its value stop at the max; the figure beside it shows the real spend.
  const filled = Math.min(row.spentMinor, row.capMinor);
  const percent = row.capMinor > 0 ? (filled / row.capMinor) * 100 : 0;
  const isMinSpend = row.bonusChannel === null;
  const goal = isMinSpend ? "min spend" : "max";
  const status =
    row.pace === "reached"
      ? `${goal} reached`
      : row.pace === "on_pace"
        ? `on pace to hit ${goal}`
        : `${formatMoney(row.remainingMinor, row.currency)} ${isMinSpend ? "to go" : "left"}`;

  return (
    <div className="flex flex-col gap-1">
      <Link
        href={countedHref(row)}
        aria-label={`${row.walletName}: see counted transactions`}
        className="flex items-baseline justify-between gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]"
      >
        <h3 className="text-sm font-medium underline" style={{ color: "var(--ink)" }}>
          {row.walletName}
        </h3>
        <p className="text-sm" style={{ color: "var(--ink)" }}>
          {formatMoney(row.spentMinor, row.currency)} / {formatMoney(row.capMinor, row.currency)}
        </p>
      </Link>
      <div
        role="progressbar"
        aria-label={row.walletName}
        aria-valuemin={0}
        aria-valuemax={row.capMinor}
        aria-valuenow={filled}
        aria-valuetext={`${formatMoney(row.spentMinor, row.currency)} of ${formatMoney(row.capMinor, row.currency)}, ${status}`}
        className="h-2 w-full overflow-hidden rounded-full"
        style={{ background: "var(--grid)" }}
      >
        <div
          style={{
            width: `${percent}%`,
            minWidth: filled > 0 ? "2px" : undefined,
            height: "100%",
            background: FILL[row.pace],
          }}
        />
      </div>
      <p className="text-sm" style={{ color: "var(--ink-2)" }}>
        {cycleLabel(row.from, row.to)} · {status}
      </p>
      {row.mismatchCount > 0 && (
        <Link
          href={`/transactions?wallet=${row.walletId}&mismatch=1&from=${row.from}&to=${row.to}`}
          aria-label={`${row.mismatchCount} no bonus, ${row.walletName}`}
          className={`self-start ${LINK_CLASS}`}
          style={{ color: "var(--ink-2)" }}
        >
          {row.mismatchCount} no bonus
        </Link>
      )}
    </div>
  );
}
