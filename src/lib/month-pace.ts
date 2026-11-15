/**
 * How a month's spending sits against its budget, for Home's hero.
 *
 * "Pace" is a straight line through the month: by the end of day N of a
 * D-day month you are expected to have spent budget × N / D. Being under
 * that line is good; over it means spending faster than the budget allows.
 *
 * Dates are `YYYY-MM-DD` strings and are read as plain calendar numbers
 * (`Date.UTC`), never through a local `Date`, for the same reason as
 * month-range.ts: a UTC+ offset must not shift a day.
 *
 * Pure: no I/O, no formatting, no currency.
 */
export type MonthPace = {
  /** Spent as a share of the budget, clamped to 0..1 for drawing a bar. */
  spentFraction: number;
  /** Where today's pace marker sits on the same bar, 0..1. */
  paceFraction: number;
  /** What pace says should be spent by the end of today. */
  expectedMinor: number;
  /** expected − spent: positive when under pace, negative when over it. */
  underPaceMinor: number;
  /** Whole days left after today; 0 on the last day and for a past month. */
  daysLeft: number;
  /** Budget left per day after today, or null once nothing is left or no days remain. */
  perDayLeftMinor: number | null;
  /** Spent more than the whole budget. */
  isOver: boolean;
};

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

export function monthPace(a: {
  spentMinor: number;
  budgetMinor: number;
  /** First and last day of the month, inclusive. */
  from: string;
  to: string;
  today: string;
}): MonthPace {
  const totalDays = dayNumber(a.to) - dayNumber(a.from) + 1;
  // A past month is complete; a future one (not reachable from Home) has
  // not started. Clamp rather than trust the caller.
  const elapsed = Math.min(totalDays, Math.max(0, dayNumber(a.today) - dayNumber(a.from) + 1));
  const daysLeft = totalDays - elapsed;
  const budget = Math.max(0, a.budgetMinor);

  const expectedMinor = Math.round((budget * elapsed) / totalDays);
  const leftMinor = budget - a.spentMinor;
  // Shared across the days after today, matching "12 days left" beside it.
  const perDayLeftMinor = leftMinor > 0 && daysLeft > 0 ? Math.floor(leftMinor / daysLeft) : null;

  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return {
    spentFraction: budget > 0 ? clamp(a.spentMinor / budget) : 0,
    paceFraction: clamp(elapsed / totalDays),
    expectedMinor,
    underPaceMinor: expectedMinor - a.spentMinor,
    daysLeft,
    perDayLeftMinor,
    isOver: a.spentMinor > budget,
  };
}
