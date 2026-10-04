import { afterEach, describe, expect, it, vi } from "vitest";
import { monthRange, monthRangeOf, parseMonthParam, shiftMonth } from "./month-range";

describe("monthRange under NEXT_PUBLIC_APP_TIMEZONE", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("picks the month of the APP timezone's calendar date, not the process's", () => {
    // 23:00 UTC on 31 August: still August in New York, already
    // 1 September in Singapore. Same reasoning as today.test.ts's sibling.
    const instant = new Date("2026-08-31T23:00:00Z");
    vi.stubEnv("NEXT_PUBLIC_APP_TIMEZONE", "America/New_York");
    expect(monthRange(instant)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    vi.stubEnv("NEXT_PUBLIC_APP_TIMEZONE", "Asia/Singapore");
    expect(monthRange(instant)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });
});

describe("monthRange", () => {
  it("spans the whole calendar month of the given date", () => {
    expect(monthRange(new Date(2026, 7, 15))).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("gets February right in a leap year", () => {
    expect(monthRange(new Date(2028, 1, 3))).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("builds strings from LOCAL parts, never via toISOString", () => {
    // A date early in the month, in a timezone behind UTC, round-trips through
    // toISOString() as the PREVIOUS month. Asserting the first-of-month
    // directly is what catches a reintroduced toISOString().
    expect(monthRange(new Date(2026, 7, 1)).from).toBe("2026-08-01");
  });
});

describe("monthRangeOf", () => {
  it("spans a named month", () => {
    expect(monthRangeOf("2026-09")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("gets February right in leap and common years", () => {
    expect(monthRangeOf("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRangeOf("2027-02")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
  });
});

describe("shiftMonth", () => {
  it("moves within a year", () => {
    expect(shiftMonth("2026-09", -1)).toBe("2026-08");
    expect(shiftMonth("2026-09", 1)).toBe("2026-10");
  });

  it("crosses year boundaries both ways", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-03", -15)).toBe("2024-12");
  });
});

describe("parseMonthParam", () => {
  it("accepts a real YYYY-MM", () => {
    expect(parseMonthParam("2026-08")).toBe("2026-08");
    expect(parseMonthParam(["2026-12", "2026-01"])).toBe("2026-12");
  });

  it("drops anything else", () => {
    for (const bad of [undefined, "", "2026-13", "2026-00", "2026-8", "2026-08-01", "Aug"]) {
      expect(parseMonthParam(bad)).toBeUndefined();
    }
  });
});
