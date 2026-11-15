import Link from "next/link";
import { formatMoney } from "@/lib/money";
import { MONTH_ABBREV } from "@/lib/month-names";
import { CHANNEL_LABELS, type Channel } from "@/lib/channels";
import { cardStatus, daysLeftInCycle, type CardStatus } from "@/lib/card-ranking";
import type { Person } from "@/lib/people";
import type { CardTrackerRow } from "@/server/card-tracker";
import { PersonBadge } from "./PersonBadge";

const LINK_CLASS =
  "rounded-sm text-xs font-bold underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

// Day and month read from the string's own digits, never a `Date` (see `month-names.ts`).
const day = (iso: string) => Number(iso.slice(8, 10));
const month = (iso: string) => MONTH_ABBREV[Number(iso.slice(5, 7)) - 1];

/** "19 Oct–18 Nov", or "1–30 Nov" when the cycle sits inside one month. */
export function cycleLabel(from: string, to: string): string {
  if (from.slice(0, 7) === to.slice(0, 7)) return `${day(from)}–${day(to)} ${month(to)}`;
  return `${day(from)} ${month(from)}–${day(to)} ${month(to)}`;
}

/** Activity showing exactly the expenses behind a row's spent figure. */
function countedHref(row: CardTrackerRow): string {
  const channel = row.bonusChannel ? `&channel=${row.bonusChannel}` : "";
  return `/transactions?wallet=${row.walletId}&expenses=1${channel}&from=${row.from}&to=${row.to}`;
}

const PILL: Partial<Record<CardStatus, { text: string; bg: string; fg: string }>> = {
  avoid: { text: "Avoid", bg: "var(--cherry-tint)", fg: "var(--neg)" },
  done: { text: "Done", bg: "var(--butter-tint)", fg: "var(--on-bright)" },
};

/**
 * Every card with a max or min spend, in the order given (the Cards tab
 * passes them ranked by `rankCards`), measured over the cycle
 * `loadCardTracker` resolved. Renders nothing when no card has either.
 *
 * Each row's state is said in words beside the bar: "SGD 690.00 left",
 * "on pace to hit min spend", "max reached", and an "Avoid" pill for a
 * bonus card near its cap -- the bar's colour never carries it alone.
 */
export function CardTracker({
  rows,
  today,
  people = {},
}: {
  rows: CardTrackerRow[];
  today: string;
  /** Owner (or Shared) per wallet id, for the badge and the bar colour. */
  people?: Record<string, Person>;
}) {
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="card-bonus-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 id="card-bonus-heading" className="font-display text-base font-bold" style={{ color: "var(--ink)" }}>
          Card bonus
        </h2>
        <p className="text-xs font-bold" style={{ color: "var(--ink-2)" }}>
          Both of you
        </p>
      </div>
      <ol className="flex flex-col rounded-3xl px-4" style={{ background: "var(--surface)" }}>
        {rows.map((row, i) => (
          <CardTrackerItem key={row.walletId} row={row} rank={i + 1} today={today} person={people[row.walletId] ?? null} />
        ))}
      </ol>
    </section>
  );
}

function CardTrackerItem({
  row,
  rank,
  today,
  person,
}: {
  row: CardTrackerRow;
  rank: number;
  today: string;
  person: Person | null;
}) {
  // The bar and its value stop at the max; the figure beside it shows the real spend.
  const filled = Math.min(row.spentMinor, row.capMinor);
  const percent = row.capMinor > 0 ? (filled / row.capMinor) * 100 : 0;
  const isMinSpend = row.bonusChannel === null;
  const goal = isMinSpend ? "min spend" : "max";
  const status = cardStatus(row);
  const daysLeft = daysLeftInCycle(row.to, today);
  const words =
    row.pace === "reached"
      ? `${goal} reached`
      : row.pace === "on_pace"
        ? `on pace to hit ${goal}`
        : `${formatMoney(row.remainingMinor, row.currency)} ${isMinSpend ? "to go" : "left"}`;
  const pill = PILL[status];
  const avoid = status === "avoid";

  return (
    <li className="flex gap-3 py-3.5 [&+&]:border-t" style={{ borderColor: "var(--grid)" }}>
      <span
        className="font-display w-4 shrink-0 pt-0.5 text-sm font-extrabold"
        style={{ color: avoid ? "var(--neg)" : "var(--ink-2)" }}
      >
        {rank}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Link
            href={countedHref(row)}
            aria-label={`${row.walletName}: see counted transactions`}
            className="flex min-w-0 items-center gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
          >
            <span
              aria-hidden
              className="h-3.5 w-5 shrink-0 rounded-[4px]"
              style={{ background: person?.color ?? "var(--accent)" }}
            />
            <h3 className="truncate text-sm font-extrabold" style={{ color: "var(--ink)" }}>
              {row.walletName}
            </h3>
          </Link>
          {pill ? (
            <span
              className="shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-extrabold"
              style={{ background: pill.bg, color: pill.fg }}
            >
              {pill.text}
            </span>
          ) : (
            person && <PersonBadge person={person} label={person.name} />
          )}
        </div>
        <div
          role="progressbar"
          aria-label={row.walletName}
          aria-valuemin={0}
          aria-valuemax={row.capMinor}
          aria-valuenow={filled}
          aria-valuetext={`${formatMoney(row.spentMinor, row.currency)} of ${formatMoney(row.capMinor, row.currency)}, ${words}`}
          className="h-1.5 w-full overflow-hidden rounded-full"
          style={{ background: "var(--grid)" }}
        >
          <div
            style={{
              width: `${percent}%`,
              minWidth: filled > 0 ? "2px" : undefined,
              height: "100%",
              borderRadius: 9999,
              background: avoid ? "var(--cherry)" : (person?.color ?? "var(--accent)"),
            }}
          />
        </div>
        <div className="flex items-baseline justify-between gap-2 text-xs font-semibold">
          <p style={{ color: avoid ? "var(--neg)" : "var(--ink-2)" }}>
            <span>
              {formatMoney(row.spentMinor, row.currency)} / {formatMoney(row.capMinor, row.currency)}
            </span>
            {row.bonusChannel ? ` · ${CHANNEL_LABELS[row.bonusChannel as Channel]} only` : " min spend"}
          </p>
          <p className="shrink-0" style={{ color: "var(--ink-2)" }}>
            {daysLeft === 1 ? "last day" : `${daysLeft} days`}
          </p>
        </div>
        <p className="text-xs" style={{ color: "var(--ink-2)" }}>
          {cycleLabel(row.from, row.to)} · {words}
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
    </li>
  );
}
