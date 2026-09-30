import { describe, it, expect } from "vitest";
import { refundErrorMessage } from "./refund-errors";

describe("refundErrorMessage", () => {
  it.each([
    ["this expense has repayments", "This expense has repayments. Delete them first."],
    ["the repaid expense was deleted", "The expense this repaid was deleted."],
    ["a repayment must repay an expense", "Expense not found"],
    ["a repayment must be in the expense's currency", "A repayment must be in the same currency as its expense."],
  ])("maps %s", (db, user) => {
    expect(refundErrorMessage(db)).toBe(user);
  });

  it("returns null for anything else, so callers keep their generic message", () => {
    expect(refundErrorMessage("duplicate key value violates unique constraint")).toBeNull();
    expect(refundErrorMessage(undefined)).toBeNull();
  });
});
