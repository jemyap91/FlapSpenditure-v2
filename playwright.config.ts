import { defineConfig, devices } from "@playwright/test";

/**
 * Task 23's end-to-end harness.
 *
 * `fullyParallel: false` and `workers: 1` are load-bearing, not caution:
 * every spec here signs up a real user against the LOCAL Supabase stack and
 * the same stack is shared by both projects below. Running specs in parallel
 * against one Postgres works, but a failure then reads as "which concurrent signup
 * raced?" instead of pointing at the flow under test.
 *
 * `webServer` runs `next dev` rather than a production build. Dev is the
 * mode this app is developed in, `reuseExistingServer` makes the local loop
 * instant when a dev server is already up, and CI has no build artifact to
 * reuse anyway. The tradeoff is dev-mode compile latency on first hit of
 * each route, which is why `timeout` below is generous.
 */

/**
 * A dedicated port, not Next's default 3000. 3000 is the first thing any
 * other local project grabs (it was already taken by an unrelated backend
 * during this task), and when that happens `next dev` silently falls
 * forward to 3001 while Playwright keeps waiting on the port it was told
 * about — the run then dies on a `webServer` timeout that says nothing
 * about the real cause. Overridable so a machine that has 3100 busy too
 * can move it without editing this file.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  // Fail the CI run rather than letting a stray `test.only` silently narrow it.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // CI gets BOTH: `list` so the job log is readable inline, and `html` so
  // the workflow's failure-only artifact upload has something to collect —
  // `list` alone writes no report to disk, which would have made that
  // upload step silently produce an empty artifact.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    // Both viewports run the same flow because the shell genuinely differs
    // between them: `Sidebar` renders at md+ and `TabBar` below it (see
    // src/app/(app)/layout.tsx), and Task 19's Save button has a
    // mobile-only `bottom-20` offset that exists specifically to clear
    // TabBar. A desktop-only suite would never exercise that.
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    // `test:e2e` pins TZ=Asia/Singapore, but that env var only reaches a
    // server THIS config starts. If a `next dev` is already running on
    // this port from another terminal (no TZ pin), `reuseExistingServer`
    // (deliberately true outside CI, for local-loop speed — see the file
    // header) attaches to it instead, silently testing an SGT browser
    // against a UTC server. A budgets/month-boundary assertion can then
    // flake on the 1st or 31st with no obvious cause locally. CI always
    // starts its own server (reuseExistingServer is false there), so it is
    // unaffected.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
