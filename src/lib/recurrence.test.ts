import { describe, it, expect } from "vitest";
import { occurrencesFor, dueOccurrences, type RecurrenceRule, type RecurInterval } from "./recurrence";

const monthly = (anchorOn: string, endsOn: string | null = null): RecurrenceRule => ({
  anchorOn,
  intervalUnit: "monthly",
  endsOn,
});

describe("occurrencesFor", () => {
  it("yields the anchor itself when it is today", () => {
    expect(occurrencesFor(monthly("2026-09-01"), "2026-09-01").dates).toEqual(["2026-09-01"]);
  });

  it("yields nothing before the anchor", () => {
    expect(occurrencesFor(monthly("2026-09-10"), "2026-09-01").dates).toEqual([]);
  });

  it("never yields a future occurrence", () => {
    // A rule due on the 30th shows nothing on the 15th (spec §3.3).
    const { dates } = occurrencesFor(monthly("2026-01-30"), "2026-03-15");
    expect(dates).toEqual(["2026-01-30", "2026-02-28"]);
  });

  it("clamps a month-end anchor to each month's last day", () => {
    const { dates } = occurrencesFor(monthly("2026-01-31"), "2026-04-30");
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  /**
   * THE anti-drift case (spec §3.1). Computing each occurrence by advancing
   * from the PREVIOUS one gives 31 Jan, 28 Feb, 28 Mar — the rule silently
   * moves off the 31st forever after one short month. Every occurrence must
   * be the nth step from the ANCHOR.
   */
  it("returns to the 31st in March rather than drifting to the 28th", () => {
    const { dates } = occurrencesFor(monthly("2026-01-31"), "2026-03-31");
    expect(dates[2]).toBe("2026-03-31");
  });

  it("clamps 29 February to the 28th in a non-leap year", () => {
    const { dates } = occurrencesFor(
      { anchorOn: "2024-02-29", intervalUnit: "yearly", endsOn: null },
      // NOT 2025-12-31: that puts the twelve-month floor at 2024-12-31, which
      // correctly excludes the 2024 occurrence as too old — so the test would
      // be measuring the backstop while claiming to measure the leap clamp.
      // 2025-02-28 puts the floor at 2024-02-28, just inside the anchor.
      "2025-02-28",
    );
    expect(dates).toEqual(["2024-02-29", "2025-02-28"]);
  });

  it("advances weekly and fortnightly by whole days", () => {
    expect(
      occurrencesFor({ anchorOn: "2026-08-31", intervalUnit: "weekly", endsOn: null }, "2026-09-14")
        .dates,
    ).toEqual(["2026-08-31", "2026-09-07", "2026-09-14"]);
    expect(
      occurrencesFor(
        { anchorOn: "2026-08-31", intervalUnit: "fortnightly", endsOn: null },
        "2026-09-28",
      ).dates,
    ).toEqual(["2026-08-31", "2026-09-14", "2026-09-28"]);
  });

  it("stops at ends_on, inclusive", () => {
    const { dates } = occurrencesFor(monthly("2026-01-15", "2026-03-15"), "2026-06-01");
    expect(dates).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
  });

  it("reaches back no further than twelve months", () => {
    const { dates, olderDropped } = occurrencesFor(monthly("2020-01-15"), "2026-09-15");
    expect(dates[0]).toBe("2025-09-15");
    expect(dates).toHaveLength(13); // 2025-09-15 .. 2026-09-15
    expect(olderDropped).toBe(true);
  });

  /**
   * The cap keeps the MOST RECENT 24, not the first 24 found. Twelve months of
   * a weekly rule is ~52 occurrences, so this binds routinely — and truncating
   * the wrong end would offer a ten-month-old occurrence while hiding last
   * week's.
   */
  it("keeps the 24 most recent when the cap binds", () => {
    const { dates, olderDropped } = occurrencesFor(
      { anchorOn: "2025-09-15", intervalUnit: "weekly", endsOn: null },
      "2026-09-15",
    );
    expect(dates).toHaveLength(24);
    // 2026-09-14, NOT 2026-09-15: 52 weeks is 364 days, one short of a year,
    // so the last occurrence on or before today falls the day before it.
    expect(dates[dates.length - 1]).toBe("2026-09-14");
    expect(olderDropped).toBe(true);
  });

  /**
   * The case a bounded iterate-from-the-anchor loop silently fails: a weekly
   * rule anchored long ago needs far more steps to reach the floor than any
   * sane runaway guard allows, so the loop returns EMPTY while occurrences
   * are genuinely due. Iteration must start at the floor, not the anchor.
   */
  it("finds current occurrences for a rule anchored many years ago", () => {
    const { dates, olderDropped } = occurrencesFor(
      { anchorOn: "2000-01-05", intervalUnit: "weekly", endsOn: null },
      "2026-09-15",
    );
    expect(dates).toHaveLength(24);
    expect(dates[dates.length - 1]!>= "2026-09-08").toBe(true);
    expect(olderDropped).toBe(true);
  });

  it("does not claim older ones were dropped when none were", () => {
    expect(occurrencesFor(monthly("2026-07-01"), "2026-09-01").olderDropped).toBe(false);
  });

  it("includes the anchor itself when endsOn equals anchorOn", () => {
    // Pins the `d > rule.endsOn` comparison at the boundary: endsOn is
    // inclusive, so a rule that ends the same day it starts still yields
    // exactly the anchor, not an empty list.
    const { dates } = occurrencesFor(monthly("2026-09-01", "2026-09-01"), "2026-09-01");
    expect(dates).toEqual(["2026-09-01"]);
  });

  /**
   * Fix round 2, I1 — the exact scenario the whole-branch review proved
   * live: a monthly rule anchored 2026-01-01, paused 2026-02-15, read on
   * 2026-06-05. Before this fix, `archivedAt` was never consulted here at
   * all, so this generated FOUR occurrences after the pause (1 Mar, 1 Apr,
   * 1 May, 1 Jun) — each one a permanently-blocked row on the dashboard,
   * with no un-archive action to ever clear it (spec §6). The occurrence
   * already due BEFORE the pause (1 Feb) must still come back, matching
   * page.tsx's own reasoning for reading `recurring_rules` WITHOUT
   * `.is("archived_at", null)`.
   */
  it("stops minting occurrences after the rule was paused, but keeps the one already due before the pause", () => {
    const { dates } = occurrencesFor(
      {
        anchorOn: "2026-01-01",
        intervalUnit: "monthly",
        endsOn: null,
        archivedAt: "2026-02-15T00:00:00.000Z",
      },
      "2026-06-05",
    );
    expect(dates).toEqual(["2026-01-01", "2026-02-01"]);
  });

  it("keeps generating right up to and including an occurrence dated the same day as the pause", () => {
    // Symmetric with `endsOn`'s own inclusive boundary (the test just
    // above): a pause dated exactly on an occurrence does not withhold
    // that occurrence, only ones strictly after it.
    const { dates } = occurrencesFor(
      {
        anchorOn: "2026-01-01",
        intervalUnit: "monthly",
        endsOn: null,
        archivedAt: "2026-03-01T09:30:00.000Z",
      },
      "2026-06-05",
    );
    expect(dates).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });

  it("an omitted archivedAt behaves exactly like an active (never-paused) rule", () => {
    // Every other test in this file constructs a `RecurrenceRule` with no
    // `archivedAt` at all — this pins that `archivedAt?` being optional
    // really does default to "not paused" rather than silently excluding
    // everything.
    const { dates } = occurrencesFor(
      { anchorOn: "2026-01-01", intervalUnit: "monthly", endsOn: null },
      "2026-03-01",
    );
    expect(dates).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });
});

describe("malformed input", () => {
  it("throws rather than spinning forever on an empty anchorOn", () => {
    expect(() =>
      occurrencesFor({ anchorOn: "", intervalUnit: "monthly", endsOn: null }, "2026-09-01"),
    ).toThrow(RangeError);
  });

  // The four malformed forms named by the review: an empty string, a shape
  // mismatch, and two well-formed-looking but impossible calendar dates.
  // Each must throw rather than silently producing a garbage occurrence list.
  it.each([
    ["", "empty string"],
    ["not-a-date", "not a date at all"],
    ["2026-13-01", "month 13 does not exist"],
    ["2026-02-30", "February has no 30th"],
    ["2026-2-1", "unpadded shape mismatch"],
  ])("rejects anchorOn %j (%s)", (bad) => {
    expect(() =>
      occurrencesFor({ anchorOn: bad, intervalUnit: "monthly", endsOn: null }, "2026-09-01"),
    ).toThrow(RangeError);
  });

  it.each([
    ["", "empty string"],
    ["not-a-date", "not a date at all"],
    ["2026-13-01", "month 13 does not exist"],
    ["2026-02-30", "February has no 30th"],
    ["2026-2-1", "unpadded shape mismatch"],
  ])("rejects today %j (%s)", (bad) => {
    expect(() => occurrencesFor(monthly("2026-01-01"), bad)).toThrow(RangeError);
  });

  it.each([
    ["", "empty string"],
    ["not-a-date", "not a date at all"],
    ["2026-13-01", "month 13 does not exist"],
    ["2026-02-30", "February has no 30th"],
    ["2026-2-1", "unpadded shape mismatch"],
  ])("rejects a non-null endsOn %j (%s)", (bad) => {
    expect(() => occurrencesFor(monthly("2026-01-01", bad), "2026-09-01")).toThrow(RangeError);
  });

  it("dueOccurrences inherits the guard via occurrencesFor", () => {
    expect(() =>
      dueOccurrences(
        { anchorOn: "", intervalUnit: "monthly", endsOn: null },
        "2026-09-01",
        new Set(),
      ),
    ).toThrow(RangeError);
  });
});

/**
 * Cross-check against a naive, obviously-correct reference: iterate from
 * n = 0 (never analytically estimating an index) and keep every occurrence
 * on or after the twelve-month floor and on or before today. This is the
 * proof, cited by the review, that `firstIndexAtOrAfter`'s analytic estimate
 * never overshoots and silently skips a genuinely-due occurrence. It would
 * fail if a future "optimisation" of that estimate skipped ahead too far.
 */
describe("firstIndexAtOrAfter does not overshoot (brute-force cross-check)", () => {
  const naiveOccurrencesFor = (rule: RecurrenceRule, today: string): string[] => {
    const addDaysLocal = (iso: string, days: number): string => {
      const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
      const t = new Date(Date.UTC(y, m - 1, d + days));
      return `${String(t.getUTCFullYear()).padStart(4, "0")}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
    };
    const addMonthsLocal = (iso: string, months: number): string => {
      const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
      const total = y * 12 + (m - 1) + months;
      const ny = Math.floor(total / 12);
      const nm = (total % 12) + 1;
      const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
      const nd = Math.min(d, lastDay);
      return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
    };
    const nthLocal = (n: number): string => {
      switch (rule.intervalUnit) {
        case "weekly":
          return addDaysLocal(rule.anchorOn, 7 * n);
        case "fortnightly":
          return addDaysLocal(rule.anchorOn, 14 * n);
        case "monthly":
          return addMonthsLocal(rule.anchorOn, n);
        case "yearly":
          return addMonthsLocal(rule.anchorOn, 12 * n);
      }
    };
    const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
    const floorTotal = ty * 12 + (tm - 1) - 12;
    const floorY = Math.floor(floorTotal / 12);
    const floorM = (floorTotal % 12) + 1;
    const floorLastDay = new Date(Date.UTC(floorY, floorM, 0)).getUTCDate();
    const floorD = Math.min(td, floorLastDay);
    const floorFromToday = `${String(floorY).padStart(4, "0")}-${String(floorM).padStart(2, "0")}-${String(floorD).padStart(2, "0")}`;
    const floor = floorFromToday > rule.anchorOn ? floorFromToday : rule.anchorOn;

    const kept: string[] = [];
    for (let n = 0; n < 5000; n++) {
      const d = nthLocal(n);
      if (d > today) break;
      if (rule.endsOn !== null && d > rule.endsOn) break;
      if (d >= floor) kept.push(d);
    }
    return kept.length > 24 ? kept.slice(-24) : kept;
  };

  it("agrees with a naive from-zero iteration across intervals, anchors, and ends_on", () => {
    const intervals: RecurInterval[] = ["weekly", "fortnightly", "monthly", "yearly"];
    const anchorYears = [1995, 2000, 2005, 2010, 2015, 2020, 2022, 2024, 2026, 2028];
    const todays = ["2026-01-15", "2026-06-30", "2026-09-15", "2026-12-31"];
    let cases = 0;
    for (const intervalUnit of intervals) {
      for (const anchorYear of anchorYears) {
        for (const today of todays) {
          for (const endsOn of [null, "2027-06-15", "2020-01-01"] as const) {
            const anchorOn = `${anchorYear}-03-17`;
            if (anchorOn > today) continue;
            const rule: RecurrenceRule = { anchorOn, intervalUnit, endsOn };
            const expected = naiveOccurrencesFor(rule, today);
            const actual = occurrencesFor(rule, today).dates;
            expect(actual).toEqual(expected);
            cases++;
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(300);
  });
});

describe("dueOccurrences", () => {
  it("omits handled dates and keeps the rest", () => {
    const { dates } = dueOccurrences(
      monthly("2026-07-01"),
      "2026-09-01",
      new Set(["2026-08-01"]),
    );
    expect(dates).toEqual(["2026-07-01", "2026-09-01"]);
  });

  it("leaves an earlier occurrence due when a later one is handled", () => {
    // Record August while July is outstanding: July stays due (spec §1.3).
    const { dates } = dueOccurrences(
      monthly("2026-07-01"),
      "2026-08-01",
      new Set(["2026-08-01"]),
    );
    expect(dates).toEqual(["2026-07-01"]);
  });

  it("reports nothing due when every occurrence is handled", () => {
    const { dates } = dueOccurrences(
      monthly("2026-08-01"),
      "2026-08-01",
      new Set(["2026-08-01"]),
    );
    expect(dates).toEqual([]);
  });

  // Every other dueOccurrences test above uses a rule anchored within the
  // twelve-month floor, where olderDropped is always false — so hardcoding
  // `olderDropped: false` in the return would leave the whole suite green.
  // This rule is anchored in 2020, old enough that the floor must withhold
  // occurrences and olderDropped must be true.
  it("passes olderDropped through from occurrencesFor rather than hardcoding it", () => {
    const { olderDropped } = dueOccurrences(monthly("2020-01-15"), "2026-09-15", new Set());
    expect(olderDropped).toBe(true);
  });
});
