import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { transactionInput, transferInput, precisionError } from "@/lib/validation/transaction";
import type { TransactionInput, TransferInput } from "@/lib/validation/transaction";
import { parseAmountInput, minorUnitFor } from "@/lib/money";
import type { Database } from "@/lib/database.types";

type TxnKind = Database["public"]["Enums"]["txn_kind"];

/**
 * No file-level `"use server"` directive here, unlike src/server/actions/
 * {auth,profile,wallets}.ts — deliberately. Per node_modules/next/dist/docs/
 * 01-app/03-api-reference/01-directives/use-server.md, a file-level
 * directive marks EVERY exported function in the file as a Server
 * Function, and React's compiler enforces that every such export be an
 * `async function` ("Server Actions must be async functions" — hit live
 * while wiring up this task's verification harness: it rejected `signedAmount`,
 * a deliberately synchronous pure helper the brief calls for, and rejected
 * the arrow-function forms of `softDeleteTransaction`/`restoreTransaction`
 * too, even though both return a `Promise`). The same doc documents an
 * inline, per-function alternative — `"use server"` as the first statement
 * inside a function body marks only that function as a Server Function,
 * leaving other exports in the same file (here, `signedAmount` and the
 * private `setDeletedAt`) as ordinary code. `createTransaction`,
 * `createTransfer`, `softDeleteTransaction`, and `restoreTransaction` each
 * carry their own inline directive below instead.
 */

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
 * pre-negating its input.
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
 */
export function signedAmount(kind: TxnKind, positiveMinor: number): number {
  if (!Number.isInteger(positiveMinor) || positiveMinor <= 0) {
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
export async function createTransaction(
  input: TransactionInput,
): Promise<{ id: string } | { error: string }> {
  "use server";
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
  // breakdown.
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
export async function createTransfer(
  input: TransferInput,
): Promise<{ transferId: string } | { error: string }> {
  "use server";
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
 * statement. (The database facts for this task note that a `transfer_id`
 * isn't *guaranteed* to have exactly two rows if something else ever wrote
 * a third — updating the whole set either way is still the correct
 * behavior: it fully soft-deletes/restores whatever shares the link,
 * rather than leaving a partial set in a mismatched state.)
 *
 * `authenticated`'s column-scoped UPDATE grant on `transactions`
 * (supabase/migrations/0004_rls.sql) includes `deleted_at` and
 * `updated_at` but not, say, `id` or `wallet_id` — this only ever writes
 * the two columns the grant allows, so it never hits "permission denied
 * for table transactions." There is no trigger maintaining `updated_at` on
 * this table (unlike `created_at`'s default), so it has to be set
 * explicitly here.
 *
 * RLS's `transactions_member` policy (is_wallet_member) still applies to
 * both the SELECT and the UPDATE, so this can never touch a transaction in
 * a wallet the caller doesn't belong to — but the explicit `getUser()`
 * check below still runs first, per this task's instruction to verify
 * authentication inside every Server Function rather than relying on RLS
 * alone to reject an unauthenticated request.
 */
async function setDeletedAt(id: string, value: string | null): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: row, error: readError } = await supabase
    .from("transactions")
    .select("transfer_id")
    .eq("id", id)
    .single();
  if (readError || !row) throw new Error("Transaction not found");

  const query = supabase.from("transactions").update({
    deleted_at: value,
    updated_at: new Date().toISOString(),
  });

  const { error } = row.transfer_id
    ? await query.eq("transfer_id", row.transfer_id)
    : await query.eq("id", id);
  if (error) throw new Error("Could not update transaction");

  revalidatePath("/", "layout");
}

export async function softDeleteTransaction(id: string): Promise<void> {
  "use server";
  await setDeletedAt(id, new Date().toISOString());
}

export async function restoreTransaction(id: string): Promise<void> {
  "use server";
  await setDeletedAt(id, null);
}
