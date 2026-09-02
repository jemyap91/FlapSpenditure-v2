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
  // amount_out/amount_in, not a single amount (task-4 fix round 1 — see
  // transferEditInput's own doc comment in ./transaction.ts for the full
  // defect writeup: a single shared amount cannot represent what
  // create_transfer already models, since a cross-currency transfer's two
  // legs are genuinely different amounts). Equal here because this fixture
  // stands in for the common same-currency case; the balance invariant
  // itself is enforced by update_transfer_pair (0016_editable_transactions.
  // sql), not by this schema — see that function and updateTransfer's own
  // doc comments.
  amount_out: "50.00",
  amount_in: "50.00",
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

  /**
   * Task-4 fix round 1: this schema must be able to represent what
   * create_transfer already models on the create side — a cross-currency
   * transfer's two legs as independent amounts. Unlike this schema's
   * original single-`amount` field (which could only ever express a
   * same-currency edit), amount_out and amount_in are free to differ; the
   * balance invariant for the SAME-currency case lives in
   * update_transfer_pair (0016_editable_transactions.sql), not here — see
   * that function's own doc comment.
   */
  it("accepts different amount_out and amount_in — a cross-currency edit", () => {
    const r = transferEditInput.safeParse({ ...baseTransferEdit, amount_out: "100.00", amount_in: "92.00" });
    expect(r.success).toBe(true);
  });

  it("requires amount_out", () => {
    // Built by deletion rather than destructuring-to-omit: this project's
    // eslint config has no underscore ignore pattern, so `const { x: _x,
    // ...rest }` reports an unused binding.
    const rest: Record<string, unknown> = { ...baseTransferEdit };
    delete rest.amount_out;
    expect(transferEditInput.safeParse(rest).success).toBe(false);
  });

  it("requires amount_in", () => {
    const rest: Record<string, unknown> = { ...baseTransferEdit };
    delete rest.amount_in;
    expect(transferEditInput.safeParse(rest).success).toBe(false);
  });

  it("coerces an empty merchant to null, like note", () => {
    expect(transferEditInput.parse({ ...baseTransferEdit, merchant: "" }).merchant).toBeNull();
  });

  it("refuses a merchant over 120 characters", () => {
    const r = transferEditInput.safeParse({ ...baseTransferEdit, merchant: "x".repeat(121) });
    expect(r.success).toBe(false);
  });

  it("accepts a merchant at exactly 120 characters", () => {
    const r = transferEditInput.safeParse({ ...baseTransferEdit, merchant: "x".repeat(120) });
    expect(r.success).toBe(true);
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
