import { describe, it, expect } from "vitest";
import { repaymentSummary, ledgerCategory, repaysLabel } from "./refunds";

const eating = { name: "Eating out", color_slot: 2, icon: "utensils" };

describe("repaymentSummary", () => {
  it("subtracts repayments from what was paid", () => {
    expect(repaymentSummary(-2500, [500, 500, 500, 500])).toEqual({ paid: 2500, repaid: 2000, share: 500 });
  });
  it("goes negative when repaid more than was paid", () => {
    expect(repaymentSummary(-2000, [600, 600, 600, 600])).toEqual({ paid: 2000, repaid: 2400, share: -400 });
  });
  it("is the whole expense with no repayments", () => {
    expect(repaymentSummary(-2500, [])).toEqual({ paid: 2500, repaid: 0, share: 2500 });
  });
});

describe("ledgerCategory", () => {
  it("uses an expense's own category", () => {
    expect(ledgerCategory({ kind: "expense", categories: eating })).toBe(eating);
  });
  it("uses a refund's expense's category", () => {
    expect(ledgerCategory({ kind: "refund", categories: null, repaid_expense: { categories: eating } })).toBe(eating);
  });
  it("is null when the expense is not visible", () => {
    expect(ledgerCategory({ kind: "refund", categories: null, repaid_expense: null })).toBeNull();
  });
});

describe("repaysLabel", () => {
  it("prefers the expense's merchant, then its note", () => {
    expect(repaysLabel({ kind: "refund", repaid_expense: { merchant: "Matcha Bar", note: "team" } })).toBe("Matcha Bar");
    expect(repaysLabel({ kind: "refund", repaid_expense: { merchant: " ", note: "team matcha" } })).toBe("team matcha");
  });
  it("is null for non-refunds and invisible expenses", () => {
    expect(repaysLabel({ kind: "expense", repaid_expense: null })).toBeNull();
    expect(repaysLabel({ kind: "refund", repaid_expense: null })).toBeNull();
  });
});
