// Task 2 (editable transactions): validation for `transactionEditInput` and
// `transferEditInput` (src/lib/validation/transaction.ts), plus (task 8,
// item 1) the CREATE schemas' merchant contract.
//
// The header comment this replaces claimed `transactionInput`/`transferInput`
// were "exercised indirectly today, through src/server/actions/
// transactions.test.ts's `createTransaction`/`createTransfer` cases". That
// was not true: that file has no such cases — it covers `updateTransaction`
// and `updateTransfer` only. Task 8 adds real `createTransaction` coverage
// there, and the schema-level merchant cases below; nothing exercises
// `transferInput` beyond `refusesMerchant` at the bottom of this file.
import { describe, it, expect } from "vitest";
import { transactionInput, transferInput, transactionEditInput, transferEditInput } from "./transaction";

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

const baseCreate = {
  wallet_id: "44444444-4444-4444-8444-444444444444",
  kind: "expense" as const,
  amount: "12.50",
  category_id: "22222222-2222-4222-8222-222222222222",
  occurred_on: "2026-01-15",
  note: "Weekly shop",
  merchant: "Trader Joe's",
};

const baseTransferCreate = {
  from_wallet_id: "44444444-4444-4444-8444-444444444444",
  to_wallet_id: "55555555-5555-4555-8555-555555555555",
  amount: "50.00",
  occurred_on: "2026-01-15",
  note: "Move to savings",
};

/**
 * Task 8, item 1. `merchant` used to exist only on the two `...Edit`
 * schemas, which meant the column the user actually asked for could only be
 * filled in by recording a transaction and then editing it. These pin the
 * create-path half — and the deliberate asymmetry that a TRANSFER still has
 * no merchant on the create path, because `create_transfer`
 * (supabase/migrations/0005_transfer_fn.sql) has no such parameter.
 */
describe("transactionInput — merchant on the create path", () => {
  it("accepts a merchant on a newly created transaction", () => {
    expect(transactionInput.parse(baseCreate).merchant).toBe("Trader Joe's");
  });

  // Fails if `merchant` is declared the way `note` is on this same schema
  // (`.optional().or(z.literal(""))`), which leaves "" as "": `merchantOf`
  // in TransactionList treats a blank string as absent, so a stored "" gives
  // the row an empty primary line instead of falling back to the note or
  // the category.
  it("coerces a blank merchant to null, never storing an empty string", () => {
    const parsed = transactionInput.parse({ ...baseCreate, merchant: "" });
    expect(parsed.merchant).toBeNull();
    expect(parsed.merchant).not.toBe("");
  });

  it("coerces a whitespace-only merchant to null too", () => {
    expect(transactionInput.parse({ ...baseCreate, merchant: "   " }).merchant).toBeNull();
  });

  it("accepts an explicit null merchant", () => {
    expect(transactionInput.parse({ ...baseCreate, merchant: null }).merchant).toBeNull();
  });

  // The same 120 the column's own `length(merchant) <= 120` CHECK
  // (0016_editable_transactions.sql) and the form's `maxLength` enforce —
  // fails if the create path is given a wider cap than the edit path.
  it("accepts exactly 120 characters and refuses 121", () => {
    expect(transactionInput.safeParse({ ...baseCreate, merchant: "x".repeat(120) }).success).toBe(true);
    const tooLong = transactionInput.safeParse({ ...baseCreate, merchant: "x".repeat(121) });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues[0]?.message).toBe("Merchant is too long");
  });
});

describe("transferInput — deliberately has NO merchant", () => {
  /**
   * This is the guard on the asymmetry, not a description of a limitation.
   * `create_transfer` takes no merchant parameter, and adding one means
   * dropping and recreating a reviewed function; a transfer also moves money
   * between the user's OWN wallets, so there is no third party to name.
   * `transferEditInput` keeping its merchant (asserted in its own describe
   * below) is what makes this an asymmetry rather than an omission.
   *
   * Fails the moment someone "fixes the inconsistency" by adding `merchant`
   * to `transferInput`, which would then reach `createTransfer` and be
   * silently dropped on the floor — the RPC has nowhere to put it.
   */
  it("strips a merchant posted to the transfer create schema", () => {
    const parsed = transferInput.parse({ ...baseTransferCreate, merchant: "Trader Joe's" });
    expect(parsed).not.toHaveProperty("merchant");
  });
});

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
