import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatMoney } from "@/lib/money";
import type { MonthPace } from "@/lib/month-pace";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

/** "SGD 1,186.40" → ["SGD 1,186", ".40"], so the cents can sit smaller. */
export function splitCents(text: string): [string, string] {
  const dot = text.lastIndexOf(".");
  return dot === -1 ? [text, ""] : [text.slice(0, dot), text.slice(dot)];
}

/**
 * Home's one oxblood block (Cherry Cola rule 2): the month's spending, and,
 * when an overall budget covers every wallet, how it paces against it.
 *
 *  - On track: oxblood, a cream bar for what is spent and a butter mark for
 *    where today's pace says you should be, with "S$734 under pace".
 *  - Over budget: the only time the block changes colour, to cherry.
 *  - No overall budget: just the total.
 *
 * The figures are all in words as well as drawn (the bar is aria-hidden),
 * so nothing depends on colour or position alone.
 */
export function HomeHero({
  monthLabel,
  spentMinor,
  currency,
  budgetMinor,
  pace,
  isCurrentMonth,
  qualifier,
  prev,
  next,
}: {
  monthLabel: string;
  spentMinor: number;
  currency: string;
  /** The overall budget covering every wallet, if there is one. */
  budgetMinor: number | null;
  pace: MonthPace | null;
  isCurrentMonth: boolean;
  /** e.g. "SGD wallets only", when other currencies are left out. */
  qualifier: string | null;
  prev: { href: string; label: string };
  next: { href: string; label: string } | null;
}) {
  const over = pace?.isOver ?? false;
  const [whole, cents] = splitCents(formatMoney(spentMinor, currency));

  return (
    <section
      aria-labelledby="hero-heading"
      className="relative overflow-hidden rounded-[28px] p-6"
      style={{ background: over ? "var(--cherry-deep)" : "var(--hero)", color: "var(--on-hero)" }}
    >
      {/* The bite out of the corner, drawn behind everything. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full"
        style={{ background: over ? "var(--hero)" : "var(--hero-deep)" }}
      />
      <div className="relative flex items-center gap-1">
        <Link
          href={prev.href}
          aria-label={prev.label}
          className={`-ml-2 grid h-8 w-8 place-items-center rounded-full ${FOCUS_RING}`}
          style={{ color: "var(--on-hero-2)" }}
        >
          <ChevronLeft size={18} aria-hidden />
        </Link>
        <h2
          id="hero-heading"
          className="text-[11px] font-extrabold uppercase tracking-[0.12em]"
          style={{ color: "var(--on-hero-2)" }}
        >
          {over ? "Over budget · " : ""}Spent in {monthLabel}
        </h2>
        {next && (
          <Link
            href={next.href}
            aria-label={next.label}
            className={`grid h-8 w-8 place-items-center rounded-full ${FOCUS_RING}`}
            style={{ color: "var(--on-hero-2)" }}
          >
            <ChevronRight size={18} aria-hidden />
          </Link>
        )}
      </div>

      <p className="font-display relative mt-2 text-[40px] font-extrabold leading-none">
        {whole}
        <span className="text-[22px]" style={{ color: "var(--on-hero-2)" }}>
          {cents}
        </span>
      </p>

      <p className="relative mt-2 text-sm font-semibold" style={{ color: "var(--on-hero-2)" }}>
        {budgetMinor !== null && pace
          ? `of ${formatMoney(budgetMinor, currency)} budget${isCurrentMonth ? ` · ${pace.daysLeft} ${pace.daysLeft === 1 ? "day" : "days"} left` : ""}`
          : isCurrentMonth
            ? "spent this month"
            : `spent in ${monthLabel}`}
        {qualifier ? ` · ${qualifier}` : ""}
      </p>

      {budgetMinor !== null && pace && (
        <>
          <div aria-hidden className="relative mt-5">
            {isCurrentMonth && !over && (
              <span
                className="absolute -top-5 -translate-x-1/2 text-[10px] font-extrabold uppercase tracking-wider"
                style={{ left: `${pace.paceFraction * 100}%`, color: "var(--butter)" }}
              >
                Today&rsquo;s pace
              </span>
            )}
            <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: "rgb(255 255 255 / 0.16)" }}>
              <div
                className="h-full rounded-full"
                style={{ width: `${pace.spentFraction * 100}%`, background: "var(--on-hero)" }}
              />
            </div>
            {isCurrentMonth && !over && (
              <span
                className="absolute -top-1 h-4.5 w-0.5 -translate-x-1/2 rounded-full"
                style={{ left: `${pace.paceFraction * 100}%`, background: "var(--butter)" }}
              />
            )}
          </div>
          <div className="relative mt-3 flex items-center justify-between gap-2 text-sm font-bold">
            <span>
              {over
                ? `${formatMoney(spentMinor - budgetMinor, currency)} over`
                : pace.perDayLeftMinor !== null && isCurrentMonth
                  ? `${formatMoney(pace.perDayLeftMinor, currency)}/day left`
                  : `${formatMoney(budgetMinor - spentMinor, currency)} left`}
            </span>
            {isCurrentMonth && !over && (
              <span
                className="rounded-full px-3 py-1 text-xs font-extrabold"
                style={{ background: "var(--butter)", color: "var(--on-bright)" }}
              >
                {pace.underPaceMinor >= 0
                  ? `${formatMoney(pace.underPaceMinor, currency)} under pace`
                  : `${formatMoney(-pace.underPaceMinor, currency)} over pace`}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
