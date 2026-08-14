import { z } from "zod";
import { Constants } from "@/lib/database.types";
import { minorUnitFor } from "@/lib/money";

/**
 * `currencies` is a reference *table* (11 seeded rows — see
 * supabase/migrations/0001_reference.sql), not a Postgres enum, so unlike
 * `wallet_kind` below there is no `Constants.public.Enums` entry to derive
 * from (Task 14's "derive from Constants" pattern only applies to real enum
 * types). This list is hand-kept in sync with that seed. It is deliberately
 * a strict *subset* of src/lib/money.ts's `MINOR_UNITS` map, which also
 * lists VND, BHD and OMR for formatting purposes even though those rows are
 * not seeded — accepting one of those here would pass zod only to fail the
 * `wallets.currency_code` foreign key with a raw Postgres error. wallet.test.ts
 * asserts this list stays a subset of `MINOR_UNITS`'s keys, so a future
 * migration that adds a currency to one and not the other fails a test
 * instead of drifting silently.
 */
export const CURRENCY_CODES = [
  "USD",
  "EUR",
  "GBP",
  "AUD",
  "CAD",
  "SGD",
  "CHF",
  "CNY",
  "JPY",
  "KRW",
  "KWD",
] as const;

/**
 * The two icons onboarding/wallet-editing currently offer (bank -> landmark,
 * card -> credit-card; see src/app/onboarding/onboarding-form.tsx).
 * `icon` is a NOT NULL free-text column with no DB-level enum to enforce it,
 * so this is the only thing standing between a raw POST and an arbitrary
 * string landing in the column — validated here rather than passed through,
 * per the same "constrain enum-shaped values" rule applied to `kind` and
 * `currency_code`.
 */
export const WALLET_ICONS = ["landmark", "credit-card"] as const;

/** Same shape parseAmountInput itself checks (src/lib/money.ts) — digits,
 * optionally one decimal point, no sign. Used here only to decide whether
 * the precision check below applies; a string that doesn't match this shape
 * is left for parseAmountInput's own throw (caught in
 * src/server/actions/wallets.ts) to report as "not a valid amount", rather
 * than this refinement misreporting a garbled string as a precision
 * problem. */
const AMOUNT_SHAPE = /^\d*(\.\d*)?$/;

export const walletInput = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(60, "Name is too long"),
    kind: z.enum(Constants.public.Enums.wallet_kind),
    currency_code: z.enum(CURRENCY_CODES),
    starting_balance: z.string().trim().default("0"),
    color_slot: z.coerce.number().int().min(1).max(8),
    icon: z.enum(WALLET_ICONS),
  })
  .superRefine((data, ctx) => {
    // parseAmountInput truncates a too-precise fraction to the currency's
    // minor unit rather than rejecting it (src/lib/money.ts) — a defensible
    // policy for Task 18's keypad, which physically cannot produce more
    // fractional digits than the currency allows. This form is that
    // function's first *free-text* caller, where a user can type anything,
    // so the rejection belongs here: a JPY wallet where someone types
    // "12.999", or a USD wallet where they type "10.005", must surface an
    // error, not silently become "12" or "$10.00".
    if (!AMOUNT_SHAPE.test(data.starting_balance)) return;

    const minorUnit = minorUnitFor(data.currency_code);
    const frac = data.starting_balance.split(".")[1] ?? "";
    if (frac.length > minorUnit) {
      ctx.addIssue({
        code: "custom",
        path: ["starting_balance"],
        message:
          minorUnit === 0
            ? `${data.currency_code} has no decimal places — enter a whole number.`
            : `${data.currency_code} allows up to ${minorUnit} decimal place${minorUnit === 1 ? "" : "s"}.`,
      });
    }
  });

export type WalletInput = z.infer<typeof walletInput>;

/** Which input a failed parse's first issue is about — used to set
 * `aria-invalid` on the offending field, mirroring src/lib/validation/
 * auth.ts's `AuthField`. Derived from `WalletInput`'s own keys rather than
 * hand-declared, so a schema field rename can't silently fall out of sync
 * with this type. */
export type WalletField = keyof WalletInput;
