import { z } from "zod";
import { Constants } from "@/lib/database.types";

/**
 * `currencies` is a reference *table* (11 seeded rows — see
 * supabase/migrations/0001_reference.sql), not a Postgres enum, so unlike
 * `wallet_kind` below there is no `Constants.public.Enums` entry to derive
 * from (Task 14's "derive from Constants" pattern only applies to real enum
 * types). This list is hand-kept in sync with that seed. It is deliberately
 * a strict *subset* of src/lib/money.ts's `MINOR_UNITS` map, which also
 * lists VND, BHD and OMR for formatting purposes even though those rows are
 * not seeded — accepting one of those here would pass zod only to fail the
 * `wallets.currency_code` foreign key with a raw Postgres error.
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
 * card -> credit-card; see src/app/onboarding/page.tsx). `icon` is a NOT
 * NULL free-text column with no DB-level enum to enforce it, so this is the
 * only thing standing between a raw POST and an arbitrary string landing in
 * the column — validated here rather than passed through, per the same
 * "constrain enum-shaped values" rule applied to `kind` and `currency_code`.
 */
export const WALLET_ICONS = ["landmark", "credit-card"] as const;

export const walletInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(60, "Name is too long"),
  kind: z.enum(Constants.public.Enums.wallet_kind),
  currency_code: z.enum(CURRENCY_CODES),
  starting_balance: z.string().trim().default("0"),
  color_slot: z.coerce.number().int().min(1).max(8),
  icon: z.enum(WALLET_ICONS),
});

export type WalletInput = z.infer<typeof walletInput>;
