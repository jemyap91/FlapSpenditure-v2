// Task 2 (editable transactions): validation for `transactionEditInput` and
// `transferEditInput` (src/lib/validation/transaction.ts). `transactionInput`
// and `transferInput` themselves are exercised indirectly today, through
// src/server/actions/transactions.test.ts's `createTransaction`/
// `createTransfer` cases — this file is only the edit pair's home.
import { describe, it, expect } from "vitest";
import { transactionEditInput, transferEditInput } from "./transaction";

const baseEdit = {
  id: "11111111-1111-4111-8111-111111111111",
  amount: "12.50",
  occurred_on: "2026-01-15",
  category_id: "22222222-2222-4222-8222-222222222222",
  note: "Weekly shop",
  merchant: "Trader Joe's",
};

const baseTransferEdit = {
  transfer_id: "33333333-3333-4333-8333-333333333333",
  amount: "50.00",
  occurred_on: "2026-01-15",
  note: "Move to savings",
  merchant: "My Bank",
};

describe("transactionEditInput", () => {
  it("accepts a well-formed edit", () => {
    expect(transactionEditInput.safeParse(baseEdit).success).toBe(true);
  });

  it("coerces an empty merchant to null, like note", () => {
    // "" must not be stored: `merchantOf`/`noteOf` in TransactionList treat a
    // blank string as absent, and storing one would give a row an empty
    // heading rather than falling back to the category.
    expect(transactionEditInput.parse({ ...baseEdit, merchant: "" }).merchant).toBeNull();
  });

  it("coerces an empty note to null", () => {
    expect(transactionEditInput.parse({ ...baseEdit, note: "" }).note).toBeNull();
  });

  it("accepts an explicit null category — a non-transfer row need not have one", () => {
    expect(transactionEditInput.safeParse({ ...baseEdit, category_id: null }).success).toBe(true);
  });

  it("refuses a merchant over 120 characters", () => {
    const r = transactionEditInput.safeParse({ ...baseEdit, merchant: "x".repeat(121) });
    expect(r.success).toBe(false);
  });

  it("accepts a merchant at exactly 120 characters", () => {
    const r = transactionEditInput.safeParse({ ...baseEdit, merchant: "x".repeat(120) });
    expect(r.success).toBe(true);
  });

  it("refuses a malformed date", () => {
    // z.iso.date(), never a bare regex: a regex accepts 2026-02-30, which
    // reaches Postgres as a driver error instead of a readable message.
    expect(transactionEditInput.safeParse({ ...baseEdit, occurred_on: "2026-02-30" }).success).toBe(
      false,
    );
  });

  it("carries no wallet_id or kind — neither is editable", () => {
    const parsed = transactionEditInput.parse({ ...baseEdit, wallet_id: "x", kind: "income" } as never);
    expect(parsed).not.toHaveProperty("wallet_id");
    expect(parsed).not.toHaveProperty("kind");
  });
});

describe("transferEditInput", () => {
  it("accepts a well-formed edit", () => {
    expect(transferEditInput.safeParse(baseTransferEdit).success).toBe(true);
  });

  it("coerces an empty merchant to null, like note", () => {
    expect(transferEditInput.parse({ ...baseTransferEdit, merchant: "" }).merchant).toBeNull();
  });

  it("refuses a merchant over 120 characters", () => {
    const r = transferEditInput.safeParse({ ...baseTransferEdit, merchant: "x".repeat(121) });
    expect(r.success).toBe(false);
  });

  it("refuses a malformed date", () => {
    expect(
      transferEditInput.safeParse({ ...baseTransferEdit, occurred_on: "2026-02-30" }).success,
    ).toBe(false);
  });

  it("carries no wallet_id — wallets aren't editable", () => {
    const parsed = transferEditInput.parse({
      ...baseTransferEdit,
      from_wallet_id: "x",
      to_wallet_id: "y",
    } as never);
    expect(parsed).not.toHaveProperty("from_wallet_id");
    expect(parsed).not.toHaveProperty("to_wallet_id");
  });

  it("carries no category — a transfer cannot have one", () => {
    // 0003's transfer_shape CHECK forces category_id null on a transfer, so a
    // schema that accepted one would produce a database error rather than a
    // message.
    const parsed = transferEditInput.parse({ ...baseTransferEdit, category_id: "x" } as never);
    expect(parsed).not.toHaveProperty("category_id");
  });
});
