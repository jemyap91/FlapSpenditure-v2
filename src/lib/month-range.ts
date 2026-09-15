import { appTimeZone, calendarDateIn } from "./app-timezone";
/**
 * Current calendar month, inclusive both ends, as LOCAL calendar-date
 * strings built directly — never via `Date.toISOString()`.
 *
 * REVIEW-CAUGHT (Critical): the first version of this function built
 * `from`/`to` with `new Date(y, m, 1)` (a LOCAL midnight) and then read it
 * back with `.toISOString().slice(0, 10)` (a UTC re-interpretation). In any
 * UTC+ timezone that silently shifts the whole window backward by one day:
 * on this codebase's own dev machine (Asia/Singapore, UTC+8),
 * `new Date(2026,7,1).toISOString().slice(0,10)` is `"2026-07-31"`, not
 * `"2026-08-01"`. `occurred_on` (supabase/migrations/0003_transactions.sql)
 * is a plain `date` column with no time zone — a LOCAL calendar date — so
 * that shifted window silently counted a 31 July expense into "August" and
 * dropped a 31 August expense from it, while the header still read
 * "August 2026". This is the exact bug class `src/lib/today.ts`'s
 * `todayLocalDate()` doc comment exists to warn about (Task 19), on the
 * INPUT side of the same local/UTC round-trip this function was doing on
 * the OUTPUT side. Fixed by never constructing a `Date` for the boundary
 * values at all — `y`/`m`/`lastDay` are plain numbers, and the returned
 * strings are built by direct interpolation, so there is no local-midnight-
 * to-UTC step for a UTC+ offset to corrupt.
 *
 * The month is that of the APP's calendar date (`appTimeZone()`,
 * src/lib/app-timezone.ts), not the process's: on Vercel the process is
 * always UTC and cannot be told otherwise, so "this month" rolled over
 * eight hours late for a Singapore household. Unset, the app zone is the
 * process's own, so nothing changes locally. Residual, still not solved:
 * one zone per deployment, not per viewer — a household member in a
 * different zone from the configured one could still see a one-day-off
 * window at their own midnight. Fixing that needs the viewer's timezone to
 * reach the server (a client-set cookie, or a profile-level field — neither
 * exists in this schema today).
 *
 * Extracted from the dashboard (Task 21) so budgets and the dashboard agree
 * on what "this month" means rather than keeping two copies that could
 * drift apart.
 *
 * TEST-SUITE NOTE: `month-range.test.ts`'s "never via toISOString" case is
 * the only automated guard for the bug above, but it is meaningless in a
 * UTC test runner — in UTC, local and UTC calendar dates coincide, so a
 * reintroduced `.toISOString()` would produce the SAME string as the
 * correct local-parts version and the test would pass either way. To keep
 * the guard load-bearing, `package.json`'s `test` and `test:watch` scripts
 * pin `TZ=Asia/Singapore` (UTC+8) for the whole suite — deliberately, not
 * incidentally — so this exact regression reproduces under `npm test`
 * (and therefore in CI, which otherwise runs `ubuntu-latest` in UTC with
 * no TZ override) rather than only on a developer's own UTC+ machine.
 */
export function monthRange(now = new Date()): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  // `YYYY-MM` of the app-zone calendar date; the day-of-month is irrelevant.
  const [y, m] = calendarDateIn(now, appTimeZone()).split("-").map(Number) as [number, number];
  // Day 0 of the NEXT month is the last day of this one. Built and read in
  // UTC on purpose: `Date.UTC` + `getUTCDate` is a pure calendar
  // computation with no zone in play at all, so it cannot be shifted by
  // the process's own offset the way a local-parts round trip could.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: `${y}-${pad(m)}-01`,
    to: `${y}-${pad(m)}-${pad(lastDay)}`,
  };
}
