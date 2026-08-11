import { describe, it, expect } from "vitest";
import { formatMoney, parseAmountInput, appendDigit } from "./money";

describe("parseAmountInput", () => {
  it("converts a 2-decimal string to minor units without floating point", () => {
    expect(parseAmountInput("12.50", 2)).toBe(1250);
    expect(parseAmountInput("0.07", 2)).toBe(7);
    expect(parseAmountInput("1234567.89", 2)).toBe(123456789);
  });

  it("handles the classic float-error cases exactly", () => {
    // parseFloat("1.005") * 100 === 100.49999999999999
    expect(parseAmountInput("1.005", 2)).toBe(100);   // truncates, never rounds up wrongly
    expect(parseAmountInput("8.87", 2)).toBe(887);    // 8.87*100 === 886.9999999999999
  });

  it("respects currencies with 0 or 3 minor units", () => {
    expect(parseAmountInput("1200", 0)).toBe(1200);   // JPY
    expect(parseAmountInput("1.234", 3)).toBe(1234);  // KWD
  });

  it("pads short decimals", () => {
    expect(parseAmountInput("5.5", 2)).toBe(550);
    expect(parseAmountInput("5.", 2)).toBe(500);
    expect(parseAmountInput("5", 2)).toBe(500);
  });

  it("returns 0 for empty input", () => {
    expect(parseAmountInput("", 2)).toBe(0);
  });

  it("rejects malformed input", () => {
    expect(() => parseAmountInput("1.2.3", 2)).toThrow();
    expect(() => parseAmountInput("abc", 2)).toThrow();
    expect(() => parseAmountInput("-5", 2)).toThrow(); // sign comes from kind, not input
  });
});

describe("appendDigit", () => {
  it("builds up an amount", () => {
    expect(appendDigit("0", "1", 2)).toBe("1");
    expect(appendDigit("1", "2", 2)).toBe("12");
  });

  it("allows exactly one decimal point", () => {
    expect(appendDigit("12", ".", 2)).toBe("12.");
    expect(appendDigit("12.", ".", 2)).toBe("12.");
    expect(appendDigit("12.5", ".", 2)).toBe("12.5");
  });

  it("caps decimals at the currency's minor unit", () => {
    expect(appendDigit("12.34", "5", 2)).toBe("12.34");
    expect(appendDigit("12.3", "4", 3)).toBe("12.34");
  });

  it("refuses a decimal point for zero-decimal currencies", () => {
    expect(appendDigit("1200", ".", 0)).toBe("1200");
  });
});

describe("formatMoney", () => {
  it("formats minor units with the currency symbol", () => {
    expect(formatMoney(1250, "USD")).toBe("$12.50");
    expect(formatMoney(123456789, "USD")).toBe("$1,234,567.89");
  });

  it("formats zero-decimal currencies without a decimal point", () => {
    expect(formatMoney(1200, "JPY")).toBe("¥1,200");
  });

  it("always renders an explicit sign when asked", () => {
    expect(formatMoney(-1250, "USD", { signed: true })).toBe("−$12.50");
    expect(formatMoney(1250, "USD", { signed: true })).toBe("+$12.50");
  });
});
