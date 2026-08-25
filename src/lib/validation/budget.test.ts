// src/lib/validation/budget.test.ts
import { describe, expect, it } from "vitest";
import { budgetInput } from "@/lib/validation/budget";

describe("budgetInput", () => {
  it("accepts a plain amount", () => {
    expect(budgetInput.safeParse({ amount: "600" }).success).toBe(true);
  });

  it("rejects an empty amount rather than treating it as zero", () => {
    expect(budgetInput.safeParse({ amount: "" }).success).toBe(false);
  });

  it("rejects a negative amount — a budget is a cap, not a balance", () => {
    expect(budgetInput.safeParse({ amount: "-50" }).success).toBe(false);
  });

  it("rejects letters rather than passing them to parseAmountInput", () => {
    expect(budgetInput.safeParse({ amount: "six hundred" }).success).toBe(false);
  });
});
