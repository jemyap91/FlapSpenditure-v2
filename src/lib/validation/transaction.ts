import { z } from "zod";
import { Constants } from "@/lib/database.types";
import type { Database } from "@/lib/database.types";

type TxnKind = Database["public"]["Enums"]["txn_kind"];

/**
 * Applies the sign the ledger requires. This is the ONE place in the app
 * that turns a user-entered positive magnitude into the signed
 * `amount_minor` the database stores — the four CHECK constraints in
 * supabase/migrations/0003_transactions.sql (`expense_is_negative`,
 * `income_is_positive`, `transfer_shape`, `non_transfer_no_link`) enforce
 * the same rule again at the database layer, but failing here first gives
 * a caller a real error message instead of a raw constraint-violation
 * string.
 *
 * The sign comes from `kind` alone, never from the input's own sign —
 * `positiveMinor` is required to already be a positive integer, so a
 * caller cannot smuggle a negative income or a positive expense through by
 * pre-negating its input. `Number.isSafeInteger`, not `Number.isInteger` —
 * this is the app's single sign gate, and `Number.isInteger(2 ** 53 + 2)`
 * is `true` despite that value losing precision; unreachable today only
 * because `parseAmountInput` (src/lib/money.ts) already guards with
 * `isSafeInteger` before calling this, and this function's own boundary
 * test (`transactions.test.ts`) exercises `Number.MAX_SAFE_INTEGER`.
 *
 * `kind` is typed as the full three-value `txn_kind` union, not a
 * hand-narrowed `"expense" | "income"`, and "transfer" is rejected
 * explicitly rather than left to a default case. A transfer's two legs are
 * signed by `create_transfer` itself (supabase/migrations/
 * 0005_transfer_fn.sql: `-amount_out` / `amount_in`) — this function never
 * touches them — so a caller reaching this with `kind: "transfer"` is
 * always a mistake, and typing the parameter this way both makes that
 * mistake a caught runtime error instead of a silently-accepted sign, and
 * lets `transactions.test.ts` exercise every real `txn_kind` value against
 * this helper without an `any` cast.
 *
 * Lives here, not in src/server/actions/transactions.ts, despite being
 * conceptually a ledger/transaction concern: transactions.ts carries a
 * file-level `"use server"` directive (needed so createTransaction/
 * createTransfer/softDeleteTransaction/restoreTransaction can be imported
 * from a future Client Component — Task 19's add-transaction screen, Task
 * 20's undo toast), and per node_modules/next/dist/docs/01-app/
 * 03-api-reference/01-directives/use-server.md, a file-level directive
 * requires EVERY exported function in that file to be an `async function`.
 * A synchronous pure helper cannot live there (confirmed live: Turbopack
 * rejected it with "Server Actions must be async functions"). This file
 * has no such directive and is already the transaction schemas' home for
 * pure, pre-database logic (`precisionError` below), so it's the natural
 * place for the other one.
 */
export function signedAmount(kind: TxnKind, positiveMinor: number): number {
  if (!Number.isSafeInteger(positiveMinor) || positiveMinor <= 0) {
    throw new Error("amount must be a positive integer in minor units");
  }
  switch (kind) {
    case "expense":
      return -positiveMinor;
    case "income":
      return positiveMinor;
    case "transfer":
      throw new Error("transfers are signed by create_transfer, not signedAmount");
  }
}

/**
 * `txn_kind` also has a third value, "transfer" (supabase/migrations/
 * 0003_transactions.sql), but a transfer is never created through
 * `createTransaction` — it's two linked rows written atomically by the
 * `create_transfer` RPC (0005_transfer_fn.sql), which also applies the
 * sign to each leg itself. `.exclude(["transfer"])` derives this narrower
 * set from the same `Constants.public.Enums` the wallet/theme schemas
 * already use (Task 14's pattern, followed by Task 15's `wallet_kind`)
 * rather than hand-declaring a fresh `["expense", "income"]` tuple that
 * could silently drift from the real enum if a migration ever renames a
 * value.
 */
export const nonTransferKind = z.enum(Constants.public.Enums.txn_kind).exclude(["transfer"]);

/**
 * Same shape `parseAmountInput` itself checks (src/lib/money.ts) — digits,
 * optionally one decimal point, no sign. The sign is never read from user
 * text; it comes from `kind` alone (`signedAmount` in
 * src/server/actions/transactions.ts).
 */
const AMOUNT_SHAPE = /^\d*(\.\d*)?$/;

/**
 * `parseAmountInput` truncates a fraction longer than the currency's
 * `minor_unit` rather than rejecting it (src/lib/money.ts) — a defensible
 * policy for Task 18's keypad, which physically cannot produce more
 * fractional digits than the currency allows. This action's amount field is
 * free text (a raw POST, or a future non-keypad form), so — following the
 * precedent set in src/lib/validation/wallet.ts for Task 15's onboarding
 * form — rejection belongs at the validation layer instead: a JPY
 * transaction where someone types "12.999" must surface an error, not
 * silently become "12".
 *
 * Unlike `wallet.ts`'s `starting_balance` check, this can't live inside a
 * zod `.superRefine` on `transactionInput`/`transferInput`: a transaction's
 * currency is the *wallet's* currency, not a field the client submits, so
 * it's only known after `src/server/actions/transactions.ts` looks the
 * wallet up. This function is exported so that lookup site can call it
 * explicitly once the currency is known, for every amount field on both
 * schemas (`transactionInput.amount`, `transferInput.amount`, and
 * `transferInput.amount_in` when present).
 *
 * Returns `undefined` for a malformed (non-numeric-shaped) string rather
 * than a precision message — that case is left for `parseAmountInput`'s own
 * throw to report as "not a valid amount," matching `wallet.ts`'s identical
 * reasoning (a garbled string isn't a precision problem, it isn't a number
 * at all).
 */
export function precisionError(
  raw: string,
  minorUnit: number,
  currencyCode: string,
): string | undefined {
  const trimmed = raw.trim();
  if (!AMOUNT_SHAPE.test(trimmed)) return undefined;

  const frac = trimmed.split(".")[1] ?? "";
  if (frac.length <= minorUnit) return undefined;

  return minorUnit === 0
    ? `${currencyCode} has no decimal places — enter a whole number.`
    : `${currencyCode} allows up to ${minorUnit} decimal place${minorUnit === 1 ? "" : "s"}.`;
}

export const transactionInput = z.object({
  wallet_id: z.uuid(),
  kind: nonTransferKind,
  amount: z.string().trim().min(1, "Enter an amount"),
  category_id: z.uuid("Choose a category"),
  // Stricter than a `\d{4}-\d{2}-\d{2}` regex: z.iso.date() rejects
  // calendar-invalid strings like "2023-02-30" (verified — JS's own
  // `Date.parse` silently rolls that over to March 2 instead of failing,
  // so a plain regex would let it through to Postgres and surface as a raw
  // driver error instead of a validation message).
  occurred_on: z.iso.date("Enter a valid date"),
  note: z.string().trim().max(280, "Note is too long").optional().or(z.literal("")),
});

export const transferInput = z
  .object({
    from_wallet_id: z.uuid(),
    to_wallet_id: z.uuid(),
    amount: z.string().trim().min(1, "Enter an amount"),
    // Only meaningful for a cross-currency transfer — see the check in
    // createTransfer. Omitted, the destination is assumed to receive
    // exactly what the source sent, which only makes sense same-currency.
    amount_in: z.string().trim().optional(),
    occurred_on: z.iso.date("Enter a valid date"),
    note: z.string().trim().max(280, "Note is too long").optional().or(z.literal("")),
  })
  .refine((v) => v.from_wallet_id !== v.to_wallet_id, {
    message: "Choose two different wallets",
    path: ["to_wallet_id"],
  });

export type TransactionInput = z.infer<typeof transactionInput>;
export type TransferInput = z.infer<typeof transferInput>;
