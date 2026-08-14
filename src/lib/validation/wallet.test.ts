import { describe, expect, it } from "vitest";
import { walletInput, CURRENCY_CODES, WALLET_ICONS } from "./wallet";
import { MINOR_UNITS } from "@/lib/money";

const valid = {
  name: "Everyday account",
  kind: "bank",
  currency_code: "USD",
  starting_balance: "0",
  color_slot: "1",
  icon: "landmark",
};

describe("walletInput", () => {
  it("accepts a well-formed submission", () => {
    const result = walletInput.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("trims and requires a non-empty name", () => {
    expect(walletInput.safeParse({ ...valid, name: "   " }).success).toBe(false);
    expect(walletInput.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("rejects a name over 60 characters", () => {
    expect(walletInput.safeParse({ ...valid, name: "a".repeat(61) }).success).toBe(false);
    expect(walletInput.safeParse({ ...valid, name: "a".repeat(60) }).success).toBe(true);
  });

  it("only accepts the two real wallet_kind values", () => {
    expect(walletInput.safeParse({ ...valid, kind: "card" }).success).toBe(true);
    expect(walletInput.safeParse({ ...valid, kind: "crypto" }).success).toBe(false);
    expect(walletInput.safeParse({ ...valid, kind: "" }).success).toBe(false);
  });

  it("only accepts a seeded currency code", () => {
    expect(walletInput.safeParse({ ...valid, currency_code: "VND" }).success).toBe(false);
    expect(walletInput.safeParse({ ...valid, currency_code: "usd" }).success).toBe(false);
    expect(walletInput.safeParse({ ...valid, currency_code: "XXX" }).success).toBe(false);
  });

  it("only accepts a known icon, not arbitrary text a raw POST could send", () => {
    expect(walletInput.safeParse({ ...valid, icon: "skull" }).success).toBe(false);
    expect(walletInput.safeParse({ ...valid, icon: "<script>" }).success).toBe(false);
  });

  it("coerces color_slot to a number and enforces the 1-8 range", () => {
    const result = walletInput.safeParse({ ...valid, color_slot: "8" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.color_slot).toBe(8);

    expect(walletInput.safeParse({ ...valid, color_slot: "0" }).success).toBe(false);
    expect(walletInput.safeParse({ ...valid, color_slot: "9" }).success).toBe(false);
    expect(walletInput.safeParse({ ...valid, color_slot: "1.5" }).success).toBe(false);
  });

  it("defaults starting_balance to \"0\" when omitted", () => {
    const withoutBalance = {
      name: valid.name,
      kind: valid.kind,
      currency_code: valid.currency_code,
      color_slot: valid.color_slot,
      icon: valid.icon,
    };
    const result = walletInput.safeParse(withoutBalance);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.starting_balance).toBe("0");
  });

  describe("precision — rejects a fraction longer than the currency allows", () => {
    it("rejects JPY (0 decimal places) given a fractional amount", () => {
      const result = walletInput.safeParse({
        ...valid,
        currency_code: "JPY",
        starting_balance: "12.999",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]!.path).toEqual(["starting_balance"]);
        expect(result.error.issues[0]!.message).toMatch(/JPY/);
      }
    });

    it("accepts a whole-number JPY amount", () => {
      expect(
        walletInput.safeParse({ ...valid, currency_code: "JPY", starting_balance: "1500" })
          .success
      ).toBe(true);
    });

    it("rejects USD (2 decimal places) given a 3rd fractional digit", () => {
      const result = walletInput.safeParse({
        ...valid,
        currency_code: "USD",
        starting_balance: "10.005",
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]!.message).toMatch(/USD/);
    });

    it("accepts a 2-decimal USD amount", () => {
      expect(
        walletInput.safeParse({ ...valid, currency_code: "USD", starting_balance: "10.00" })
          .success
      ).toBe(true);
    });

    it("accepts exactly the currency's precision, KWD's 3 decimal places", () => {
      expect(
        walletInput.safeParse({ ...valid, currency_code: "KWD", starting_balance: "12.345" })
          .success
      ).toBe(true);
    });

    it("rejects KWD given a 4th fractional digit", () => {
      expect(
        walletInput.safeParse({ ...valid, currency_code: "KWD", starting_balance: "12.3456" })
          .success
      ).toBe(false);
    });

    it("leaves a malformed (non-numeric) amount for parseAmountInput's own rejection", () => {
      // Two decimal points isn't a precision problem, it's not a number at
      // all — the precision refinement should stay out of the way so the
      // action's parseAmountInput try/catch reports it as "not a valid
      // amount" instead of a confusing currency-precision message.
      const result = walletInput.safeParse({
        ...valid,
        currency_code: "USD",
        starting_balance: "12.34.56",
      });
      expect(result.success).toBe(true); // shape check passes zod; parseAmountInput rejects it downstream
    });
  });
});

describe("CURRENCY_CODES", () => {
  it("stays a subset of money.ts's MINOR_UNITS, so every offered currency has a known precision", () => {
    for (const code of CURRENCY_CODES) {
      expect(MINOR_UNITS).toHaveProperty(code);
    }
  });

  it("matches the 11 rows seeded in supabase/migrations/0001_reference.sql", () => {
    expect(CURRENCY_CODES).toHaveLength(11);
  });
});

describe("WALLET_ICONS", () => {
  it("has exactly the two icons onboarding offers", () => {
    expect(WALLET_ICONS).toEqual(["landmark", "credit-card"]);
  });
});
