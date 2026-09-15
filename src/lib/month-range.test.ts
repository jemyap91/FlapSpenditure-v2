import { afterEach, describe, expect, it, vi } from "vitest";
import { monthRange } from "./month-range";

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
