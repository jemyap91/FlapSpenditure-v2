import { describe, it, expect } from "vitest";
import { monthPace } from "./month-pace";

const NOV = { from: "2026-11-01", to: "2026-11-30" };

describe("monthPace", () => {
  it("matches the design's worked example: S$1,186.40 of S$3,200 on 18 Nov", () => {
    const p = monthPace({ ...NOV, spentMinor: 118640, budgetMinor: 320000, today: "2026-11-18" });
    expect(p.expectedMinor).toBe(192000);
    expect(p.underPaceMinor).toBe(73360);
    expect(p.daysLeft).toBe(12);
    expect(p.perDayLeftMinor).toBe(16780);
    expect(p.paceFraction).toBeCloseTo(0.6);
    expect(p.spentFraction).toBeCloseTo(0.37075);
    expect(p.isOver).toBe(false);
  });

  it("goes negative when spending runs ahead of pace", () => {
    const p = monthPace({ ...NOV, spentMinor: 200000, budgetMinor: 320000, today: "2026-11-10" });
    expect(p.underPaceMinor).toBeLessThan(0);
    expect(p.isOver).toBe(false);
  });

  it("is over once spending passes the whole budget, with nothing left per day", () => {
    const p = monthPace({ ...NOV, spentMinor: 334810, budgetMinor: 320000, today: "2026-11-25" });
    expect(p.isOver).toBe(true);
    expect(p.spentFraction).toBe(1);
    expect(p.perDayLeftMinor).toBeNull();
  });

  it("treats a past month as complete", () => {
    const p = monthPace({ from: "2026-10-01", to: "2026-10-31", spentMinor: 1000, budgetMinor: 3100, today: "2026-11-18" });
    expect(p.paceFraction).toBe(1);
    expect(p.daysLeft).toBe(0);
    expect(p.expectedMinor).toBe(3100);
    expect(p.perDayLeftMinor).toBeNull();
  });

  it("counts the first day as one day elapsed", () => {
    const p = monthPace({ ...NOV, spentMinor: 0, budgetMinor: 300000, today: "2026-11-01" });
    expect(p.expectedMinor).toBe(10000);
    expect(p.daysLeft).toBe(29);
  });

  it("handles February in a leap year", () => {
    const p = monthPace({ from: "2028-02-01", to: "2028-02-29", spentMinor: 0, budgetMinor: 29000, today: "2028-02-29" });
    expect(p.daysLeft).toBe(0);
    expect(p.expectedMinor).toBe(29000);
  });
});
