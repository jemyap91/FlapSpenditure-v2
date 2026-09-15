import { appTimeZone, calendarDateIn } from "./app-timezone";
/**
 * Today's date as `YYYY-MM-DD` in the caller's LOCAL calendar day, never
 * `new Date().toISOString()` — that is a UTC re-interpretation of a local
 * moment, and at 01:00 in Kuwait (UTC+3) it yields *yesterday's* date, which
 * is wrong wherever "today" means the user's own calendar day, not
 * Greenwich's.
 *
 * Read via LOCAL getters (`getFullYear`/`getMonth`/`getDate`) only, never
 * mixed with a UTC read of the same value — src/lib/month-range.ts documents
 * a shipped Critical bug from mixing those two directions on a single value.
 *
 * The single, canonical definition. Previously duplicated under two
 * different names with the identical body (the four lines below this
 * comment, unchanged): a private `todayLocalDate()` inside
 * `src/components/TransactionForm.tsx` (seeding the add-transaction date
 * field) and a private `todayLocal()` inside
 * `src/server/actions/recurring.ts` (`recordOccurrence`'s
 * is-this-actually-due check) — the names and surrounding doc comments had
 * diverged, but the logic itself had not. Two divergent notions of "today"
 * in one ledger app is precisely the bug class this project has already
 * been bitten by twice (see month-range.ts's own history) — both call
 * sites now import this one function instead.
 *
 * "Local" now means the APP's calendar (`appTimeZone()`, src/lib/
 * app-timezone.ts), not the process's: on Vercel the process is always UTC
 * and cannot be told otherwise, so a Server Component or Server Function
 * reading its own clock trailed a Singapore household by eight hours a
 * day. With `NEXT_PUBLIC_APP_TIMEZONE` unset this still reads the
 * process's own zone, so nothing changes locally or under the test suite's
 * `TZ` pin. What remains out of scope is PER-VIEWER time: one zone for the
 * deployment, shared with `month-range.ts`.
 */
export function todayLocalDate(): string {
  return calendarDateIn(new Date(), appTimeZone());
}
