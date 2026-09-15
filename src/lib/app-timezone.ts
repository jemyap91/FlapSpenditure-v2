/**
 * The calendar this app keeps, independent of where the process runs.
 *
 * Every "what day is it" question in this codebase (`todayLocalDate`,
 * `monthRange`) used to be answered from the process's own local clock.
 * That is right on a laptop and in `npm test` (which pins
 * `TZ=Asia/Singapore`), and wrong on Vercel: its runtime is always UTC and
 * `TZ` is on its reserved-name list, so the server's local date trails a
 * Singapore household by eight hours every day. Seen live: a recurring rule
 * "monthly on the 15th" was absent from the dashboard's DUE section until
 * 08:00 on the 15th, and month totals rolled over eight hours late.
 *
 * `NEXT_PUBLIC_APP_TIMEZONE` names an IANA zone (`Asia/Singapore`). It is
 * `NEXT_PUBLIC_` because both sides consult it: the server for due checks
 * and month windows, the browser for seeding the add-transaction date --
 * and a due date the server computes must be the same day the client
 * would seed. Unset, the process's own zone is used, which keeps local
 * development and the test suite's `TZ` pin behaving exactly as before.
 *
 * One zone for the whole deployment, not per viewer: a household's members
 * share a calendar, and threading each viewer's zone up to the server would
 * need a cookie nothing in this codebase sends. That is the spec's stated
 * limitation (see today.ts), narrowed from "wherever the process runs" to
 * "wherever the household is".
 */
export function appTimeZone(): string {
  // Referenced literally so Next inlines it into client bundles.
  return process.env.NEXT_PUBLIC_APP_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * `YYYY-MM-DD` for `instant` as read on the wall calendar of `timeZone`.
 * `en-CA` is the one locale whose default date format is already ISO
 * order, so no part reordering is needed; `formatToParts` is still used
 * rather than trusting the joined string, since that is what the locale
 * actually guarantees.
 */
export function calendarDateIn(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
