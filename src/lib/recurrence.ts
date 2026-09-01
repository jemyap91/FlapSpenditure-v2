/**
 * Recurrence arithmetic for recurring rules. Pure, database-free, and
 * deliberately string-in/string-out over `YYYY-MM-DD` calendar dates.
 *
 * NEVER build a Date from local components here. src/lib/month-range.ts
 * documents a shipped Critical bug where `new Date(y, m, 1)` (local midnight)
 * read back via `.toISOString()` (UTC) shifted a month window by a day in
 * UTC+8. `anchor_on`, `ends_on` and `occurred_on` are all plain `date`
 * columns with no timezone, so every calculation below is either integer
 * maths or a strictly UTC Date round trip — UTC has no DST and no offset, so
 * it cannot shift a calendar date.
 */

export type RecurInterval = "weekly" | "fortnightly" | "monthly" | "yearly";

export type RecurrenceRule = {
  anchorOn: string;
  intervalUnit: RecurInterval;
  endsOn: string | null;
};

export type Occurrences = {
  dates: string[];
  /** True when the twelve-month floor or the 24 cap withheld an occurrence.
   *  The UI must say so: silent truncation reads as "you are up to date". */
  olderDropped: boolean;
};

/** Most recent occurrences offered at once (spec §1.5). */
const MAX_OCCURRENCES = 24;
/** How far back due occurrences reach (spec §1.5). */
const LOOKBACK_MONTHS = 12;

type Parts = { y: number; m: number; d: number };

function parse(iso: string): Parts {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

/** Accepts exactly `YYYY-MM-DD` naming a real calendar date. Rejects `""`,
 *  shape mismatches (`"not-a-date"`, `"2026-2-1"`), and well-formed-looking
 *  but impossible dates (`"2026-13-01"`, `"2026-02-30"`) by round-tripping
 *  through a UTC Date and checking the fields survived unchanged. */
function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parse(s);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function assertIsoDate(field: string, value: string): void {
  if (!isIsoDate(value)) {
    throw new RangeError(`${field} must be a valid YYYY-MM-DD date, got ${JSON.stringify(value)}`);
  }
}

function format({ y, m, d }: Parts): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Days in a month, via a UTC probe of "day 0 of the next month". */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(iso: string, days: number): string {
  const { y, m, d } = parse(iso);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return format({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

/** Add whole months, clamping the day to the target month's length: the 31st
 *  becomes the 28th in February WITHOUT the anchor moving (see `nth`). */
function addMonthsClamped(iso: string, months: number): string {
  const { y, m, d } = parse(iso);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return format({ y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) });
}

/**
 * The nth occurrence, ALWAYS measured from the anchor. Never from the previous
 * occurrence: 31 Jan advanced month-by-month gives 28 Feb then 28 Mar, and the
 * rule has silently left the 31st forever (spec §3.1).
 */
function nth(rule: RecurrenceRule, n: number): string {
  switch (rule.intervalUnit) {
    case "weekly":
      return addDays(rule.anchorOn, 7 * n);
    case "fortnightly":
      return addDays(rule.anchorOn, 14 * n);
    case "monthly":
      return addMonthsClamped(rule.anchorOn, n);
    case "yearly":
      return addMonthsClamped(rule.anchorOn, 12 * n);
  }
}

/** Whole days from `a` to `b`, both `YYYY-MM-DD`. UTC-only, so no DST or
 *  offset can shift the count. */
function daysBetween(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  const ms = Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d);
  return Math.round(ms / 86_400_000);
}

/** Whole calendar months from `a` to `b`, ignoring day-of-month. */
function monthsBetween(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  return (pb.y - pa.y) * 12 + (pb.m - pa.m);
}

/**
 * Index of the first occurrence at or after `floor`, computed rather than
 * found by iterating.
 *
 * Iterating up from n = 0 under a fixed bound looks equivalent and is not: a
 * WEEKLY rule anchored in 2000 needs ~1350 steps to reach a 2026 floor, so a
 * bounded loop exits having collected nothing and reports "older dropped"
 * over an empty list — silently hiding every occurrence actually due. The
 * bound reads as a runaway guard and behaves as a correctness bug.
 *
 * The estimate can be one short after month-end clamping, so it is nudged
 * forward until it genuinely lands on or after the floor. That loop runs at
 * most once.
 */
function firstIndexAtOrAfter(rule: RecurrenceRule, floor: string): number {
  if (floor <= rule.anchorOn) return 0;
  const step = rule.intervalUnit;
  let n =
    step === "weekly"
      ? Math.floor(daysBetween(rule.anchorOn, floor) / 7)
      : step === "fortnightly"
        ? Math.floor(daysBetween(rule.anchorOn, floor) / 14)
        : step === "monthly"
          ? monthsBetween(rule.anchorOn, floor)
          : Math.floor(monthsBetween(rule.anchorOn, floor) / 12);
  if (n < 0) n = 0;
  // Structural backstop, independent of the validation callers are required
  // to perform: the loop is proven to need at most ONE correction, so a
  // bound of 4 is generous. Without this, a future input class nobody
  // anticipated (e.g. a NaN estimate) would spin forever rather than fail.
  for (let guard = 0; guard < 4; guard++) {
    if (nth(rule, n) >= floor) return n;
    n++;
  }
  throw new RangeError(`firstIndexAtOrAfter failed to converge for floor ${JSON.stringify(floor)}`);
}

/**
 * The lookback floor `occurrencesFor` computes internally (twelve months
 * before `today`, clamped) — exported so a caller that needs to BOUND A
 * DATABASE READ to "everything `occurrencesFor`/`dueOccurrences` could
 * possibly consult" can match that floor exactly, rather than re-deriving a
 * possibly-drifting approximation of the same date (fix round 1, I5: the
 * dashboard's due-list reads of `recurring_skips`/`transactions` were
 * unbounded, and PostgREST's `max_rows` truncates silently).
 *
 * Deliberately NOT clamped to any rule's own `anchorOn` the way
 * `occurrencesFor`'s internal `floor` is (`floorDate > rule.anchorOn ?
 * floorDate : rule.anchorOn`) — a per-rule bound would be tighter for a
 * rule anchored more recently, but a caller bounding a READ across MANY
 * rules at once needs the loosest floor that is still safe for all of
 * them, and this unclamped date is exactly that: every rule's actual floor
 * is this date or later, so nothing any rule could need is ever excluded.
 */
export function lookbackFloor(today: string): string {
  assertIsoDate("today", today);
  return addMonthsClamped(today, -LOOKBACK_MONTHS);
}

export function occurrencesFor(rule: RecurrenceRule, today: string): Occurrences {
  assertIsoDate("anchorOn", rule.anchorOn);
  assertIsoDate("today", today);
  if (rule.endsOn !== null) assertIsoDate("endsOn", rule.endsOn);

  const floorDate = lookbackFloor(today);
  const floor = floorDate > rule.anchorOn ? floorDate : rule.anchorOn;

  const n0 = firstIndexAtOrAfter(rule, floor);
  const kept: string[] = [];

  // Bounded at 100: twelve months of a WEEKLY rule is ~53 occurrences, so
  // this cannot truncate a legitimate result now that iteration starts at the
  // floor rather than at the anchor.
  for (let i = 0; i < 100; i++) {
    const d = nth(rule, n0 + i);
    if (d > today) break;
    if (rule.endsOn !== null && d > rule.endsOn) break;
    kept.push(d);
  }

  if (kept.length > MAX_OCCURRENCES) {
    // The MOST RECENT, not the first found: truncating the other end would
    // hide last week's occurrence behind one from ten months ago.
    return { dates: kept.slice(-MAX_OCCURRENCES), olderDropped: true };
  }
  // `n0 > 0` means the floor itself withheld older occurrences.
  return { dates: kept, olderDropped: n0 > 0 };
}

/**
 * Due = generated minus handled. `handled` holds the occurrence dates that
 * already have a non-deleted transaction or a skip row, so Record and Skip
 * work in any order — recording August leaves July due.
 */
export function dueOccurrences(
  rule: RecurrenceRule,
  today: string,
  handled: ReadonlySet<string>,
): Occurrences {
  const all = occurrencesFor(rule, today);
  return { dates: all.dates.filter((d) => !handled.has(d)), olderDropped: all.olderDropped };
}
