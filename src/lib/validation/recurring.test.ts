// src/lib/validation/recurring.test.ts
//
// Mirrors src/lib/validation/wallet.test.ts's shape: pure zod-schema tests,
// no Supabase involved. See recurring.ts's doc comments for why each rule
// exists (kind excludes transfer, amount precision matches wallet.ts's
// wording, ends_on collapses "" to null).
import { describe, it, expect } from "vitest";
import { recurringInput } from "./recurring";

const base = {
  name: "Rent",
  kind: "expense",
  amount: "1500.00",
  currency_code: "SGD",
  category_id: "8f2b1c4e-0000-4000-8000-000000000000",
  wallet_id: "8f2b1c4e-1111-4000-8000-000000000000",
  interval_unit: "monthly",
  anchor_on: "2026-09-01",
  ends_on: "",
};

describe("recurringInput", () => {
  it("accepts a well-formed monthly expense", () => {
    expect(recurringInput.safeParse(base).success).toBe(true);
  });

  it("treats an empty end date as no end, not as an invalid date", () => {
    const parsed = recurringInput.parse(base);
    expect(parsed.ends_on).toBeNull();
  });

  it("refuses a transfer rule", () => {
    // Out of scope (spec §1.2), and refused here as well as by the CHECK
    // constraint, so the user sees a message rather than a database error.
    const r = recurringInput.safeParse({ ...base, kind: "transfer" });
    expect(r.success).toBe(false);
  });

  it("refuses an end date before the anchor", () => {
    const r = recurringInput.safeParse({ ...base, anchor_on: "2026-09-01", ends_on: "2026-08-01" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]!.message).toMatch(/end.*after|before/i);
  });

  it("refuses a fraction the currency cannot hold", () => {
    const r = recurringInput.safeParse({ ...base, currency_code: "JPY", amount: "12.5" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]!.message).toMatch(/no decimal places/i);
  });

  it("refuses a blank name", () => {
    expect(recurringInput.safeParse({ ...base, name: "   " }).success).toBe(false);
  });
});
