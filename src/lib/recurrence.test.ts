import { describe, it, expect } from "vitest";
import { occurrencesFor, dueOccurrences, type RecurrenceRule } from "./recurrence";

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
});
