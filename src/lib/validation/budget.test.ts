// src/lib/validation/budget.test.ts
import { describe, expect, it } from "vitest";
import { budgetInput } from "@/lib/validation/budget";

const WALLET_ID = "11111111-1111-4111-8111-111111111111";

describe("budgetInput", () => {
  it("accepts an amount with at least one wallet", () => {
    expect(budgetInput.safeParse({ amount: "600", walletIds: [WALLET_ID] }).success).toBe(true);
  });

  it("rejects an empty wallet set — it would be visible to everyone", () => {
    expect(budgetInput.safeParse({ amount: "600", walletIds: [] }).success).toBe(false);
  });

  it("rejects a negative amount", () => {
    expect(budgetInput.safeParse({ amount: "-50", walletIds: [WALLET_ID] }).success).toBe(false);
  });

  it("rejects letters", () => {
    expect(budgetInput.safeParse({ amount: "six", walletIds: [WALLET_ID] }).success).toBe(false);
  });

  it("rejects a malformed wallet id", () => {
    expect(budgetInput.safeParse({ amount: "600", walletIds: ["not-a-uuid"] }).success).toBe(false);
  });
});
