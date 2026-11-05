import { describe, expect, it } from "vitest";
import {
  cycleFor,
  expenseWarnings,
  isMismatch,
  merchantKey,
  paceFor,
  suggestChannel,
} from "./card-bonus";

describe("cycleFor", () => {
  it.each([
    ["2026-11-05", 1, "2026-11-01", "2026-11-30"],
    ["2026-11-05", 19, "2026-10-19", "2026-11-18"],
    ["2026-11-19", 19, "2026-11-19", "2026-12-18"],
    ["2026-11-24", 24, "2026-11-24", "2026-12-23"],
    ["2026-11-01", 2, "2026-10-02", "2026-11-01"],
    ["2027-01-05", 19, "2026-12-19", "2027-01-18"],
    ["2026-02-28", 31, "2026-02-28", "2026-03-30"],
    ["2026-03-30", 31, "2026-02-28", "2026-03-30"],
    ["2026-03-31", 31, "2026-03-31", "2026-04-29"],
  ])("cycleFor(%s, %i)", (on, day, from, to) => {
    expect(cycleFor(on, day)).toEqual({ from, to });
  });
});

describe("paceFor", () => {
  const base = { capMinor: 100000, from: "2026-11-01", to: "2026-11-30" };

  it("is reached at the max, even on day 1", () => {
    expect(paceFor({ ...base, spentMinor: 100000, today: "2026-11-01" })).toBe("reached");
  });

  it("is under on day 2 however high the spend, below the max", () => {
    expect(paceFor({ ...base, spentMinor: 99999, today: "2026-11-02" })).toBe("under");
  });

  it("is on pace when the run rate reaches the max", () => {
    expect(paceFor({ ...base, spentMinor: 64000, today: "2026-11-05" })).toBe("on_pace");
  });

  it("is under when the run rate falls short", () => {
    expect(paceFor({ ...base, spentMinor: 10000, today: "2026-11-15" })).toBe("under");
  });

  it("uses the whole cycle once today is past the end", () => {
    expect(paceFor({ ...base, spentMinor: 99000, today: "2026-12-10" })).toBe("under");
    expect(paceFor({ ...base, spentMinor: 100000, today: "2026-12-10" })).toBe("reached");
  });
});

describe("isMismatch", () => {
  it("is false when either side is null", () => {
    expect(isMismatch(null, "online")).toBe(false);
    expect(isMismatch("online", null)).toBe(false);
    expect(isMismatch(null, null)).toBe(false);
  });
  it("is false when equal and true when they differ", () => {
    expect(isMismatch("online", "online")).toBe(false);
    expect(isMismatch("in_store", "online")).toBe(true);
  });
});

describe("suggestChannel", () => {
  it("prefers the rule, then the wallet, then null", () => {
    expect(suggestChannel("bill", "online")).toBe("bill");
    expect(suggestChannel(null, "online")).toBe("online");
    expect(suggestChannel(null, null)).toBeNull();
  });
});

describe("merchantKey", () => {
  it("ignores case and surrounding spaces", () => {
    expect(merchantKey(" UNIQLO ")).toBe(merchantKey("uniqlo"));
  });
});

describe("expenseWarnings", () => {
  const base = {
    walletName: "Woman's World",
    bonusChannel: "online" as const,
    capMinor: null,
    currency: "USD",
    channel: null,
    amountMinor: 2000,
    spentBeforeMinor: null,
  };

  it("warns when the channel misses the bonus channel", () => {
    expect(expenseWarnings({ ...base, channel: "in_store" })).toEqual([
      "Woman's World earns its bonus Online, so this won't earn it.",
    ]);
  });

  it("warns when an expense goes past the max", () => {
    const w = expenseWarnings({
      ...base,
      channel: "online",
      capMinor: 100000,
      spentBeforeMinor: 99000,
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("past its $1,000.00 max");
  });

  it("does not warn exactly at the max", () => {
    expect(
      expenseWarnings({ ...base, channel: "online", capMinor: 100000, spentBeforeMinor: 98000 }),
    ).toEqual([]);
  });

  it("does not warn about the max when spend is unknown", () => {
    expect(
      expenseWarnings({ ...base, channel: "online", capMinor: 100000, spentBeforeMinor: null }),
    ).toEqual([]);
  });
});
