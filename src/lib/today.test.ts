import { describe, expect, it, vi, afterEach } from "vitest";
import { todayLocalDate } from "./today";

/**
 * Fix round 2, I4 — `today.ts`'s own 30-line doc comment exists specifically
 * to warn against `new Date().toISOString().slice(0, 10)` (a UTC
 * reinterpretation of a local moment), yet nothing under the configuration
 * `npm test`/CI actually runs ever pinned that regression: proven live,
 * replacing `todayLocalDate`'s body with exactly that line left `npm test`
 * 575/575 green.
 *
 * `package.json` pins `TZ=Asia/Singapore` (UTC+8) for `npm test`/`test:watch`
 * PRECISELY so a local/UTC divergence reproduces without an exotic override
 * (see `src/lib/month-range.ts`'s own identical doc comment on the same
 * pin) — but a pinned timezone only matters if the moment under test
 * actually falls at an hour where the local and UTC calendar dates DIFFER.
 * Every existing indirect pin of "today" in this codebase
 * (`recurring.test.ts`, `page.test.tsx`) uses
 * `vi.setSystemTime(new Date(2026, 8, 1, 12, 0, 0))` — NOON local, where
 * Singapore (UTC+8) and UTC still agree on the calendar day, so the bug
 * class this file exists to prevent was never actually exercised.
 *
 * This suite pins 00:30 LOCAL instead: Singapore midnight is UTC 16:00 the
 * PREVIOUS day, so a reintroduced `.toISOString()` read would report 31
 * August while the local calendar day is genuinely 1 September — this test
 * fails under that mutation without needing `TZ=Pacific/Kiritimati` or any
 * other timezone `npm test`/CI never runs.
 */
describe("todayLocalDate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the LOCAL calendar date at an hour where local and UTC disagree", () => {
    vi.useFakeTimers();
    // Constructed from LOCAL components (month-range.test.ts's own
    // identical convention) — whatever timezone the process is actually
    // running under (TZ=Asia/Singapore for `npm test`) is what both this
    // construction and `todayLocalDate()`'s own local getters agree on, so
    // this test's expectation never depends on the runner's own clock.
    vi.setSystemTime(new Date(2026, 8, 1, 0, 30, 0));

    expect(todayLocalDate()).toBe("2026-09-01");
  });

  it("still agrees with the local date at an hour where local and UTC happen to coincide", () => {
    // A NOON pin, matching every existing indirect pin elsewhere in this
    // codebase — kept as a sibling case, not a replacement for the one
    // above: this one alone is exactly what left the mutation undetected.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 1, 12, 0, 0));

    expect(todayLocalDate()).toBe("2026-09-01");
  });

  it("pads the month and day to two digits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 0, 15, 0));

    expect(todayLocalDate()).toBe("2026-01-05");
  });
});
