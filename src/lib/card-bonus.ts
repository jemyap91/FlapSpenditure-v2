import { CHANNEL_LABELS, type Channel } from "./channels";
import { merchantKey } from "./entry-suggestions";
import { formatMoney } from "./money";

export { merchantKey };

const DAY_MS = 86_400_000;

function parse(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

function format(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** First day of the cycle that begins in month `m` (0-based, may overflow), clamped to its length. */
function cycleStart(y: number, m: number, startDay: number): number {
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(startDay, lastDay));
}

/** The billing cycle containing `on`, inclusive both ends, as YYYY-MM-DD. */
export function cycleFor(on: string, startDay: number): { from: string; to: string } {
  const { y, m, d } = parse(on);
  const onMs = Date.UTC(y, m - 1, d);
  const thisStart = cycleStart(y, m - 1, startDay);
  const startsThisMonth = onMs >= thisStart;
  const from = startsThisMonth ? thisStart : cycleStart(y, m - 2, startDay);
  const next = startsThisMonth ? cycleStart(y, m, startDay) : thisStart;
  return { from: format(from), to: format(next - DAY_MS) };
}

function daysBetween(from: string, to: string): number {
  const a = parse(from);
  const b = parse(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

export function paceFor(a: {
  spentMinor: number;
  capMinor: number;
  from: string;
  to: string;
  today: string;
}): "reached" | "on_pace" | "under" {
  if (a.spentMinor >= a.capMinor) return "reached";
  const total = daysBetween(a.from, a.to) + 1;
  const elapsed = daysBetween(a.from, a.today < a.to ? a.today : a.to) + 1;
  // Too early in the cycle for a run rate to mean anything.
  if (elapsed < 3) return "under";
  return (a.spentMinor / elapsed) * total >= a.capMinor ? "on_pace" : "under";
}

/** A null channel on either side is never a mismatch. */
export function isMismatch(channel: Channel | null, bonusChannel: Channel | null): boolean {
  return channel !== null && bonusChannel !== null && channel !== bonusChannel;
}

export function suggestChannel(
  ruleChannel: Channel | null,
  walletChannel: Channel | null,
): Channel | null {
  return ruleChannel ?? walletChannel;
}

export function expenseWarnings(a: {
  walletName: string;
  bonusChannel: Channel | null;
  capMinor: number | null;
  currency: string;
  channel: Channel | null;
  amountMinor: number;
  spentBeforeMinor: number | null;
  /** The max is a quota every expense counts toward (0034), not a ceiling
   *  on bonus-channel spend: passing it is the goal, never a warning. */
  countsAllSpend?: boolean;
}): string[] {
  const warnings: string[] = [];
  const quota = a.countsAllSpend === true && a.capMinor !== null;
  if (a.bonusChannel && isMismatch(a.channel, a.bonusChannel)) {
    warnings.push(
      quota
        ? `${a.walletName} earns its bonus ${CHANNEL_LABELS[a.bonusChannel]}, so this won't earn it, but it still counts toward the ${formatMoney(a.capMinor!, a.currency)} max.`
        : `${a.walletName} earns its bonus ${CHANNEL_LABELS[a.bonusChannel]}, so this won't earn it.`,
    );
  }
  if (
    !quota &&
    a.channel !== null &&
    a.channel === a.bonusChannel &&
    a.capMinor !== null &&
    a.spentBeforeMinor !== null &&
    a.spentBeforeMinor + a.amountMinor > a.capMinor
  ) {
    warnings.push(
      `This takes ${a.walletName} past its ${formatMoney(a.capMinor, a.currency)} max for this cycle.`,
    );
  }
  return warnings;
}
