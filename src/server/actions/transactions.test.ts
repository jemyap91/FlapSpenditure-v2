import { describe, it, expect } from "vitest";
import { signedAmount } from "./transactions";
import { precisionError } from "@/lib/validation/transaction";

describe("signedAmount", () => {
  it("makes an expense negative", () => {
    expect(signedAmount("expense", 1250)).toBe(-1250);
  });

  it("makes an income positive", () => {
    expect(signedAmount("income", 1250)).toBe(1250);
  });

  it("accepts the smallest positive boundary — 1 minor unit", () => {
    expect(signedAmount("expense", 1)).toBe(-1);
    expect(signedAmount("income", 1)).toBe(1);
  });

  it("accepts a large boundary value (Number.MAX_SAFE_INTEGER)", () => {
    expect(signedAmount("income", Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(signedAmount("expense", Number.MAX_SAFE_INTEGER)).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it("rejects a zero magnitude for both expense and income", () => {
    expect(() => signedAmount("expense", 0)).toThrow();
    expect(() => signedAmount("income", 0)).toThrow();
  });

  it("rejects a negative magnitude — sign comes from kind, never input", () => {
    expect(() => signedAmount("expense", -5)).toThrow();
    expect(() => signedAmount("income", -5)).toThrow();
  });

  it("rejects a non-integer magnitude", () => {
    expect(() => signedAmount("expense", 12.5)).toThrow();
    expect(() => signedAmount("income", 12.5)).toThrow();
  });

  it("rejects kind 'transfer' — transfer legs are signed by create_transfer, not this helper", () => {
    expect(() => signedAmount("transfer", 1250)).toThrow();
    // Even a well-formed positive magnitude doesn't make "transfer" valid
    // here — the rejection is about the kind, not the amount.
    expect(() => signedAmount("transfer", 1)).toThrow();
  });
});

describe("precisionError (src/lib/validation/transaction.ts)", () => {
  it("flags a fraction longer than the currency's minor unit", () => {
    expect(precisionError("12.999", 0, "JPY")).toMatch(/JPY/);
    expect(precisionError("10.005", 2, "USD")).toMatch(/USD/);
    expect(precisionError("12.3456", 3, "KWD")).toMatch(/KWD/);
  });

  it("accepts an amount within the currency's precision", () => {
    expect(precisionError("1500", 0, "JPY")).toBeUndefined();
    expect(precisionError("10.00", 2, "USD")).toBeUndefined();
    expect(precisionError("12.345", 3, "KWD")).toBeUndefined();
  });

  it("leaves a malformed amount for parseAmountInput's own rejection", () => {
    expect(precisionError("12.34.56", 2, "USD")).toBeUndefined();
  });
});
