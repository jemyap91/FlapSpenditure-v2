// src/lib/validation/budget.test.ts
import { describe, expect, it } from "vitest";
import { budgetInput } from "@/lib/validation/budget";

describe("budgetInput", () => {
  it("accepts an amount with at least one account", () => {
    expect(budgetInput.safeParse({ amount: "600", walletIds: ["a"] }).success).toBe(true);
  });

  it("rejects an empty account set — it would be visible to everyone", () => {
    expect(budgetInput.safeParse({ amount: "600", walletIds: [] }).success).toBe(false);
  });

  it("rejects a negative amount", () => {
    expect(budgetInput.safeParse({ amount: "-50", walletIds: ["a"] }).success).toBe(false);
  });

  it("rejects letters", () => {
    expect(budgetInput.safeParse({ amount: "six", walletIds: ["a"] }).success).toBe(false);
  });
});
