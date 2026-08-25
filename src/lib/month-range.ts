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
 * "August 2026". This is the exact bug class `TransactionForm.tsx`'s
 * `todayLocalDate()` doc comment exists to warn about (Task 19), on the
 * INPUT side of the same local/UTC round-trip this function was doing on
 * the OUTPUT side. Fixed by never constructing a `Date` for the boundary
 * values at all — `y`/`m`/`lastDay` are plain numbers, and the returned
 * strings are built by direct interpolation, so there is no local-midnight-
 * to-UTC step for a UTC+ offset to corrupt.
 *
 * Residual, deliberately NOT fixed here (flagged, not solved): this still
 * matches the SERVER's calendar month/day, not necessarily the actual
 * viewer's — a request straddling local midnight in a timezone far from
 * the server's could still see a one-day-off window, and any header label
 * built the same way (e.g. `new Date().toLocaleString(...)`, evaluated
 * server-side) has the identical exposure. A real fix needs the viewer's
 * timezone to reach the server (a client-set cookie, an `Intl`-derived
 * offset sent up, or a profile-level timezone field — none of which exist
 * in this schema today) and is out of scope here.
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
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11
  const lastDay = new Date(y, m + 1, 0).getDate(); // still a Date, but only
  // ever used for its LOCAL getDate() — never round-tripped through
  // toISOString(), so it carries no UTC-shift risk.
  return {
    from: `${y}-${pad(m + 1)}-01`,
    to: `${y}-${pad(m + 1)}-${pad(lastDay)}`,
  };
}
