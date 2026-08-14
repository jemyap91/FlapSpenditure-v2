"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  transactionInput,
  transferInput,
  precisionError,
  signedAmount,
} from "@/lib/validation/transaction";
import type { TransactionInput, TransferInput } from "@/lib/validation/transaction";
import { parseAmountInput, minorUnitFor } from "@/lib/money";

export type TransactionResult = { id: string } | { error: string };
export type TransferResult = { transferId: string } | { error: string };
export type MutationResult = { ok: true } | { error: string };

/**
 * File-level `"use server"` (like src/server/actions/{auth,profile,
 * wallets}.ts), not per-function inline directives. Per node_modules/
 * next/dist/docs/01-app/03-api-reference/01-directives/use-server.md, a
 * file-level directive is what lets a Server Function be imported directly
 * into a Client Component (Task 19's add-transaction screen, Task 20's
 * undo toast will both import from this file) — an inline, function-body
 * directive does not: confirmed live, `next build` on a throwaway Client
 * Component importing an inline-directive export fails with "It is not
 * allowed to define inline 'use server' annotated Server Actions in Client
 * Components." Every export below is consequently an `async function`
 * (the file-level directive's own requirement); `signedAmount`, the one
 * genuinely synchronous pure helper this task's brief calls for, lives in
 * src/lib/validation/transaction.ts instead — see that file's doc comment
 * for the full reasoning.
 */

/**
 * Postgres error text that create_transfer (supabase/migrations/
 * 0005_transfer_fn.sql) deliberately raises for the caller to see —
 * written by this codebase, not leaked provider/driver detail, so
 * forwarding it verbatim doesn't run afoul of the "never forward raw
 * provider messages" rule that src/server/actions/wallets.ts and profile.ts
 * follow (that rule exists to stop e.g. an auth error string becoming an
 * account-enumeration oracle; these five strings carry no such risk). Any
 * OTHER error from the RPC call — a permission error, an unexpected
 * constraint violation, a connection failure — falls through to a generic
 * message instead, so this allowlist is a floor, not a filter that lets
 * arbitrary Postgres text through.
 */
const KNOWN_TRANSFER_ERRORS = new Set([
  "cannot transfer to the same wallet",
  "transfer amounts and date must not be null",
  "transfer amounts must be positive",
  "not a member of both wallets",
  "a same-currency transfer must balance",
]);

/**
 * Creates a single expense or income transaction.
 *
 * Server Functions are reachable via direct POST requests, not just through
 * whatever form Task 19 eventually builds (see node_modules/next/dist/docs/
 * 01-app/02-guides/server-actions.md, "Security"), so `input`'s static
 * `TransactionInput` type is not trusted — it is re-validated with
 * `transactionInput.safeParse` exactly as if the parameter were `unknown`,
 * and the caller is re-derived from the session via `getUser()` rather than
 * trusted from anywhere in `input` (there is no `created_by` or `owner_id`
 * field in the schema for exactly this reason).
 */
export async function createTransaction(input: TransactionInput): Promise<TransactionResult> {
  const parsed = transactionInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { wallet_id, kind, amount, category_id, occurred_on, note } = parsed.data;

  // `wallets_select` RLS (is_wallet_member) already means this SELECT comes
  // back empty for a wallet the caller doesn't belong to — no separate
  // membership check is needed here, and the INSERT below is independently
  // gated by `transactions_member`'s own is_wallet_member check.
  const { data: wallet } = await supabase
    .from("wallets")
    .select("currency_code")
    .eq("id", wallet_id)
    .single();
  if (!wallet) return { error: "Account not found" };

  // categories_own RLS scopes this to the caller's own categories, so a
  // category_id belonging to someone else (or that doesn't exist) comes
  // back null here rather than as a foreign-key error from the INSERT.
  // The kind check catches a mismatch nothing in the schema's CHECK
  // constraints forbids — e.g. filing an expense against an income
  // category — which would otherwise silently corrupt Task 21's category
  // breakdown. (Whether an ARCHIVED category should also be rejected here
  // is a deliberate open question, not an oversight — flagged in this
  // task's report for Task 17 to decide, alongside the identical question
  // for archived wallets.)
  const { data: category } = await supabase
    .from("categories")
    .select("kind")
    .eq("id", category_id)
    .single();
  if (!category) return { error: "Choose a category" };
  if (category.kind !== kind) return { error: "That category doesn't match this transaction type" };

  const minorUnit = minorUnitFor(wallet.currency_code);
  const precisionIssue = precisionError(amount, minorUnit, wallet.currency_code);
  if (precisionIssue) return { error: precisionIssue };

  let magnitude: number;
  try {
    magnitude = parseAmountInput(amount, minorUnit);
  } catch {
    return { error: "That amount isn't valid" };
  }
  if (magnitude === 0) return { error: "Enter an amount greater than zero" };

  const { data, error } = await supabase
    .from("transactions")
    .insert({
      wallet_id,
      created_by: user.id,
      kind,
      amount_minor: signedAmount(kind, magnitude),
      currency_code: wallet.currency_code,
      category_id,
      occurred_on,
      note: note || null,
    })
    .select("id")
    .single();

  // This schema has no user-actionable constraint on transactions beyond
  // what the checks above already cover (amount shape/precision, category
  // kind, wallet existence) — a raw Postgres error here could only leak
  // implementation detail, never useful guidance, so it is never forwarded
  // (same convention as src/server/actions/wallets.ts).
  if (error) return { error: "Could not save transaction. Please try again." };

  revalidatePath("/", "layout");
  return { id: data.id };
}

/**
 * Creates a transfer between two wallets as two linked rows, via the
 * `create_transfer` RPC (supabase/migrations/0005_transfer_fn.sql). The two
 * rows must appear atomically — the client cannot express that — and the
 * invariants (distinct wallets, positive amounts, membership on both sides,
 * a same-currency transfer balancing) are enforced in Postgres, not
 * reimplemented here. This function's job is turning free-text input into
 * the RPC's two positive bigint arguments and translating its errors, not
 * pairing the rows itself.
 */
export async function createTransfer(input: TransferInput): Promise<TransferResult> {
  const parsed = transferInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { from_wallet_id, to_wallet_id, amount, amount_in, occurred_on, note } = parsed.data;

  const { data: wallets } = await supabase
    .from("wallets")
    .select("id, currency_code")
    .in("id", [from_wallet_id, to_wallet_id]);
  const from = wallets?.find((w) => w.id === from_wallet_id);
  const to = wallets?.find((w) => w.id === to_wallet_id);
  if (!from || !to) return { error: "Account not found" };

  const fromMinorUnit = minorUnitFor(from.currency_code);
  const toMinorUnit = minorUnitFor(to.currency_code);

  const outPrecisionIssue = precisionError(amount, fromMinorUnit, from.currency_code);
  if (outPrecisionIssue) return { error: outPrecisionIssue };
  if (amount_in) {
    const inPrecisionIssue = precisionError(amount_in, toMinorUnit, to.currency_code);
    if (inPrecisionIssue) return { error: inPrecisionIssue };
  }

  // Without an explicit amount_in, the destination is assumed to receive
  // the exact figure the source sent — only meaningful when both wallets
  // share a currency. create_transfer itself only ENFORCES equal amounts
  // when currencies match (0005_transfer_fn.sql's "a same-currency transfer
  // must balance" check); a mismatched-currency pair with no amount_in
  // supplied would otherwise reach the RPC as e.g. "100" USD out and "100"
  // JPY in with no error at all — a ~100x mispricing recorded with
  // confidence. Rejecting it here, before the RPC call, is cheaper than
  // relying on a future UI to always fill amount_in correctly.
  if (from.currency_code !== to.currency_code && !amount_in) {
    return { error: "Enter a destination amount for a cross-currency transfer" };
  }

  let out: number;
  let inn: number;
  try {
    out = parseAmountInput(amount, fromMinorUnit);
    inn = amount_in ? parseAmountInput(amount_in, toMinorUnit) : out;
  } catch {
    return { error: "That amount isn't valid" };
  }
  if (out <= 0 || inn <= 0) return { error: "Enter an amount greater than zero" };

  const { data, error } = await supabase.rpc("create_transfer", {
    from_wallet: from_wallet_id,
    to_wallet: to_wallet_id,
    amount_out: out,
    amount_in: inn,
    on_date: occurred_on,
    // create_transfer's `note` parameter is `text default null`, but the
    // generated RPC Args type marks it `note?: string` (optional, not
    // nullable) rather than `string | null` — Supabase's codegen maps a
    // defaulted SQL parameter to an optional TS property, not a nullable
    // one. `undefined` (an omitted key once JSON-serialized) reaches
    // Postgres exactly the way an absent argument would: the function's own
    // `default null` takes over, so this is equivalent to sending `null`
    // explicitly, just typed correctly.
    note: note || undefined,
  });

  if (error) {
    return {
      error: KNOWN_TRANSFER_ERRORS.has(error.message)
        ? error.message
        : "Could not complete transfer. Please try again.",
    };
  }

  revalidatePath("/", "layout");
  return { transferId: data };
}

/**
 * Soft delete / restore, sharing one implementation. A transfer's two legs
 * go together — undo must restore (or remove) an intact pair, never half of
 * one — so when the target row is a transfer leg, the UPDATE is scoped by
 * `transfer_id` instead of `id`, moving every row sharing that id in one
 * statement.
 *
 * That statement only ever affects rows RLS lets this caller see, though —
 * `transactions_member` is keyed on `is_wallet_member(wallet_id)` per-row,
 * not per-transfer, so if the caller is a member of only ONE of the two
 * wallets a transfer touches (membership can change after a transfer is
 * created — e.g. an owner removes a member from one wallet later), the
 * other leg is invisible to this query and cannot be affected by it, full
 * stop; there is no privilege this function can use to reach it without a
 * service-role key, which this app does not have. An earlier version of
 * this comment claimed the whole set "always" moves together — that was
 * inaccurate, and this codebase has already been bitten twice by a comment
 * asserting a property the code didn't actually deliver, so it isn't
 * repeated here. What this function DOES do, as a defense-in-depth check
 * against a *narrower* failure mode (a constraint or concurrent change
 * blocking only some of the rows this caller can see): it counts how many
 * rows share `transfer_id` and are visible to the caller BEFORE the
 * update, then compares that to how many rows the UPDATE actually
 * affected, and reports an error rather than a silent partial success if
 * they differ.
 *
 * `authenticated`'s column-scoped UPDATE grant on `transactions`
 * (supabase/migrations/0004_rls.sql) includes `deleted_at` and
 * `updated_at` but not, say, `id` or `wallet_id` — this only ever writes
 * the two columns the grant allows, so it never hits "permission denied
 * for table transactions." There is no trigger maintaining `updated_at` on
 * this table (unlike `created_at`'s default), so it has to be set
 * explicitly here.
 *
 * Returns a result object rather than throwing (a deliberate deviation
 * from the brief's `Promise<void>` signature — see this task's report): a
 * thrown Error inside a Server Function is masked to an opaque digest in
 * production, which would leave Task 20's undo toast unable to
 * distinguish "not signed in" from "not found" from "update failed," let
 * alone render any of them.
 */
async function setDeletedAt(id: string, value: string | null): Promise<MutationResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { data: row, error: readError } = await supabase
    .from("transactions")
    .select("transfer_id")
    .eq("id", id)
    .single();
  if (readError || !row) return { error: "Transaction not found" };

  // How many rows sharing this transfer_id (or just this one row, for a
  // non-transfer) are visible to the caller right now — the baseline the
  // UPDATE's own affected-row count is checked against below.
  let expectedCount = 1;
  if (row.transfer_id) {
    const { count } = await supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("transfer_id", row.transfer_id);
    expectedCount = count ?? 1;
  }

  const query = supabase.from("transactions").update({
    deleted_at: value,
    updated_at: new Date().toISOString(),
  });

  const { data: updated, error } = row.transfer_id
    ? await query.eq("transfer_id", row.transfer_id).select("id")
    : await query.eq("id", id).select("id");
  if (error) return { error: "Could not update transaction" };
  if (!updated || updated.length !== expectedCount) {
    return { error: "Only part of this transfer could be updated" };
  }

  revalidatePath("/", "layout");
  return { ok: true };
}

export async function softDeleteTransaction(id: string): Promise<MutationResult> {
  return setDeletedAt(id, new Date().toISOString());
}

export async function restoreTransaction(id: string): Promise<MutationResult> {
  return setDeletedAt(id, null);
}
