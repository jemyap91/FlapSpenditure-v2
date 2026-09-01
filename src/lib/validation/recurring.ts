import { z } from "zod";
import { Constants } from "@/lib/database.types";
import type { RecurInterval } from "@/lib/recurrence";
import { minorUnitFor } from "@/lib/money";
import { CURRENCY_CODES } from "@/lib/validation/wallet";
import { nonTransferKind } from "@/lib/validation/transaction";

/**
 * `recurring_rules.interval_unit` is a real Postgres enum (supabase/
 * migrations/0015_recurring.sql: `recur_interval`), so per Task 14's
 * "derive from Constants" convention (src/lib/validation/wallet.ts's
 * `kind`, transaction.ts's `nonTransferKind`) this is read from the
 * generated `Constants` rather than hand-declared as a fresh tuple.
 *
 * Typed against `RecurInterval` (imported from src/lib/recurrence.ts, not
 * redeclared here) rather than left as `string[]`: every date-arithmetic
 * function in that file switches over `RecurInterval` exhaustively with no
 * `default` case, so a future migration that renames or adds an interval
 * value without updating recurrence.ts would fail to compile right here,
 * instead of surfacing as a silent runtime mismatch between what this form
 * accepts and what recurrence.ts knows how to compute.
 */
const RECUR_INTERVALS: readonly RecurInterval[] = Constants.public.Enums.recur_interval;

/** Same shape parseAmountInput itself checks (src/lib/money.ts) — digits,
 * optionally one decimal point, no sign. Used here only to decide whether
 * the precision check below applies; a string that doesn't match this shape
 * is left for parseAmountInput's own throw (caught in
 * src/server/actions/recurring.ts) to report as "not a valid amount",
 * rather than this refinement misreporting a garbled string as a precision
 * problem. Identical to wallet.ts's own `AMOUNT_SHAPE`. */
const AMOUNT_SHAPE = /^\d*(\.\d*)?$/;

export const recurringInput = z
  .object({
    /** A rule belongs to a wallet (0015), not to a user — validated here
     *  since a Server Function is reachable by direct POST. Never trusted
     *  as the write's authorization: the actions additionally verify the
     *  caller is a member before inserting. */
    wallet_id: z.uuid(),
    name: z.string().trim().min(1, "Name is required").max(60, "Name is too long"),
    // Restricted to expense|income, not the full three-value txn_kind:
    // recurring_rules.kind is typed txn_kind in the database (it shares
    // the column type with transactions), but a transfer is a linked PAIR
    // of rows with no category (spec §1.2) — a different write this task
    // does not build — and 0015's own `rule_kind_not_transfer` CHECK
    // refuses one at the database regardless of what reaches it. Reusing
    // `nonTransferKind` (rather than a fresh `z.enum(["expense",
    // "income"])`) keeps this in sync with the same live `txn_kind` enum
    // transaction.ts already derives it from.
    kind: nonTransferKind,
    // Free-text decimal string, like wallet.ts's `starting_balance` — the
    // precision check below rejects (never truncates) a fraction the
    // currency can't hold. Sign is applied later from `kind`
    // (src/server/actions/recurring.ts), never read from this string.
    amount: z.string().trim().min(1, "Enter an amount"),
    currency_code: z.enum(CURRENCY_CODES),
    category_id: z.uuid("Choose a category"),
    interval_unit: z.enum(RECUR_INTERVALS),
    // z.iso.date(), not a hand-rolled regex: it rejects calendar-invalid
    // strings like "2026-02-30" that a plain `\d{4}-\d{2}-\d{2}` pattern
    // would let through to Postgres as a raw driver error (same reasoning
    // as transaction.ts's `occurred_on`).
    anchor_on: z.iso.date("Enter a valid date"),
    // Empty string is "no end date", not an invalid one — collapsed to
    // `null` here so callers never have to special-case "" downstream.
    // Anything non-empty must still be a real calendar date.
    ends_on: z
      .union([z.literal(""), z.iso.date("Enter a valid date")])
      .transform((v) => (v === "" ? null : v)),
  })
  .superRefine((data, ctx) => {
    // Same policy and wording as wallet.ts's `starting_balance` check:
    // reject a fraction longer than the currency's minor unit allows
    // rather than silently truncating it. A malformed (non-numeric-shaped)
    // string is left alone here — it's caught by parseAmountInput's own
    // throw in the server action instead, reported as "not a valid
    // amount" rather than misdiagnosed as a precision problem.
    if (AMOUNT_SHAPE.test(data.amount)) {
      const minorUnit = minorUnitFor(data.currency_code);
      const frac = data.amount.split(".")[1] ?? "";
      if (frac.length > minorUnit) {
        ctx.addIssue({
          code: "custom",
          path: ["amount"],
          message:
            minorUnit === 0
              ? `${data.currency_code} has no decimal places — enter a whole number.`
              : `${data.currency_code} allows up to ${minorUnit} decimal place${minorUnit === 1 ? "" : "s"}.`,
        });
      }
    }

    // Mirrors 0015's own `rule_ends_after_anchor` CHECK
    // (`ends_on is null or ends_on >= anchor_on`) so a user sees a message
    // here rather than a raw constraint violation.
    if (data.ends_on !== null && data.ends_on < data.anchor_on) {
      ctx.addIssue({
        code: "custom",
        path: ["ends_on"],
        message: "End date must be on or after the anchor date.",
      });
    }
  });

export type RecurringInput = z.infer<typeof recurringInput>;

/** Which input a failed parse's first issue is about — used to set
 * `aria-invalid` on the offending field, mirroring src/lib/validation/
 * wallet.ts's `WalletField`. Derived from `RecurringInput`'s own keys
 * rather than hand-declared, so a schema field rename can't silently fall
 * out of sync with this type. */
export type RecurringField = keyof RecurringInput;
