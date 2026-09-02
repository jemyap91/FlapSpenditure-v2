"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  transactionInput,
  transferInput,
  transactionEditInput,
  transferEditInput,
  precisionError,
  signedAmount,
} from "@/lib/validation/transaction";
import type {
  TransactionInput,
  TransferInput,
  TransactionEditInput,
  TransferEditInput,
} from "@/lib/validation/transaction";
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
  // update_transfer_pair (0016_editable_transactions.sql, task-4 fix round
  // 2): raised when a transfer's UPDATE touched something other than
  // exactly two rows -- e.g. a third row inserted onto an existing
  // transfer_id via the full-table INSERT grant. Without this in the
  // allowlist, updateTransfer below would fall through to the generic
  // "Could not save transfer" message instead of a readable one.
  "a transfer edit must update exactly two legs",
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
  //
  // Task 17's decision (this check was carried from Task 16, which flagged
  // it and deferred the call): an archived wallet is rejected here exactly
  // like a nonexistent one, with the identical "Wallet not found" message
  // rather than a distinct "this wallet is archived" — archiving is meant
  // to remove a wallet from every place a NEW transaction could reference
  // it (mirroring wallets.ts's own doc comment: a wallets-management screen
  // is expected to stop offering an archived wallet as a destination), and
  // a distinct message would tell an adversarial caller a wallet with this
  // id exists and belongs to someone (possibly not even the caller — RLS
  // already filtered by membership before archived_at is even checked)
  // without granting anything useful in return. This is about *creating*
  // new transactions only; editing a transaction that already references a
  // since-archived wallet is a different action (not built yet) and can
  // make its own decision.
  const { data: wallet } = await supabase
    .from("wallets")
    .select("currency_code, archived_at")
    .eq("id", wallet_id)
    .single();
  if (!wallet || wallet.archived_at) return { error: "Wallet not found" };

  // `categories_member` RLS (0008: `is_wallet_member(wallet_id)`, which
  // REPLACED `categories_own`) scopes this to every wallet the caller
  // belongs to — which, since categories became wallet-scoped and wallets
  // became shareable, is no longer the same set as "this transaction's
  // wallet". So RLS alone stops a stranger's category but NOT a
  // cross-wallet one of the caller's own: without the explicit
  // `.eq("wallet_id", wallet_id)` below, a category from wallet A reached
  // the INSERT and died there on 0008's composite FK
  // `transactions_category_same_wallet`, surfacing as the generic "Could
  // not save transaction. Please try again." with nothing the user could
  // act on. Filtering on wallet_id here turns that dead end back into the
  // ordinary "Choose a category" validation error, and is defence in depth
  // against a direct POST naming another wallet's category id.
  //
  // The kind check catches a mismatch nothing in the schema's CHECK
  // constraints forbids — e.g. filing an expense against an income
  // category — which would otherwise silently corrupt Task 21's category
  // breakdown.
  //
  // Task 17's decision on the archived-category question this comment used
  // to carry: reject, with the same "Choose a category" message a
  // nonexistent id gets (not a distinct "this category is archived" — same
  // no-extra-information reasoning as the archived-wallet check above).
  // Spec §5.3 is explicit that archiving "hides it from pickers" — the
  // whole point of archiving a category is to stop it from being offered
  // for anything NEW, while "Archived categories still appear in
  // historical breakdowns" (same section) is a read-path guarantee about
  // reports, not a licence for new transactions to keep targeting it.
  // CategoryPicker and this task's /categories page both already query
  // `.is("archived_at", null)`, so this closes the gap between what the UI
  // offers and what a raw POST could otherwise still reach. As with the
  // wallet check, this governs creating a NEW transaction only — editing
  // one that already references a since-archived category is a different,
  // not-yet-built action.
  const { data: category } = await supabase
    .from("categories")
    .select("kind, archived_at")
    .eq("id", category_id)
    .eq("wallet_id", wallet_id)
    .single();
  if (!category || category.archived_at) return { error: "Choose a category" };
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
 * Edits an existing expense or income transaction — Task 4's transfer edit
 * is a separate action; this one refuses a transfer row outright rather than
 * silently mis-handling it (see the `kind === "transfer"` guard below).
 *
 * `wallet_id` and `kind` are never read from `input` — `transactionEditInput`
 * (src/lib/validation/transaction.ts) doesn't even have those fields, and
 * the row's real ones are loaded from the database first, exactly as this
 * function's own doc comment on that schema requires. That load also
 * doubles as existence/visibility check: `transactions_member` RLS
 * (is_wallet_member(wallet_id)) means this SELECT already comes back empty
 * for a row the caller isn't a member of, so there is no separate membership
 * check to write here, mirroring `createTransaction`'s wallet lookup.
 *
 * Every other check below mirrors `createTransaction`'s, because editing a
 * transaction must not be able to reach a state creating one couldn't: the
 * wallet must be active, the category (when one is posted — `category_id` is
 * nullable here, unlike `createTransaction`'s required field, since clearing
 * a transaction's category is a legitimate edit) must belong to the same
 * wallet, not be archived, and match the transaction's kind, and the amount
 * must be non-zero with the sign `kind` requires.
 */
export async function updateTransaction(input: TransactionEditInput): Promise<MutationResult> {
  const parsed = transactionEditInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { id, amount, occurred_on, category_id, note, merchant } = parsed.data;

  // Load the row first to learn its wallet_id and kind — a posted one is
  // never trusted, and there is no such field on transactionEditInput to
  // trust in the first place.
  //
  // `.is("deleted_at", null)` here (and on the UPDATE below) is a deliberate
  // choice, not an oversight: a soft-deleted row is not offered anywhere in
  // the UI (fix round 1 review) and editing one directly would be an
  // unstated asymmetry with `setDeletedAt`'s own restore/delete pair — this
  // action is for editing a LIVE transaction, and a deleted one must be
  // restored first. Filtered at both steps rather than just the lookup so a
  // delete racing between them still lands on "Transaction not found"
  // instead of a stray write to a row the user believes is gone.
  const { data: existing } = await supabase
    .from("transactions")
    .select("wallet_id, kind")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!existing) return { error: "Transaction not found" };
  const { wallet_id, kind } = existing;

  // A transfer leg reaching here would otherwise sail past every check below
  // (a transfer's category_id is always null, per 0003's transfer_shape
  // CHECK, so the category branch is skipped) and die inside signedAmount,
  // which throws for kind "transfer" — an uncaught throw inside a Server
  // Function is masked to an opaque digest in production (this file's own
  // doc comment), not the readable error this module promises. Refusing
  // explicitly, before any of that, keeps the promise and points the caller
  // at the right place instead.
  if (kind === "transfer") {
    return { error: "This is a transfer — edit it from the transfer, not the transaction" };
  }

  const { data: wallet } = await supabase
    .from("wallets")
    .select("currency_code, archived_at")
    .eq("id", wallet_id)
    .single();
  if (!wallet) return { error: "Wallet not found" };
  // Distinct from "Wallet not found" (fix precedent: recurring.ts's
  // recordOccurrence draws the identical distinction, and its own doc
  // comment explains why conflating "missing" and "archived" into one
  // message is wrong) — this transaction's wallet is known to exist and
  // belong to the caller (the SELECT above already proved that), so a
  // vague "not found" would be actively misleading here, unlike
  // createTransaction's identically-worded check on a wallet freshly typed
  // into a picker.
  if (wallet.archived_at) return { error: "This wallet has been archived." };

  // Unlike createTransaction, category_id may be null here — clearing a
  // transaction's category is a legitimate edit (transactionEditInput's own
  // doc comment), so the lookup and its checks are skipped entirely rather
  // than rejecting a null category the way a create would.
  if (category_id) {
    const { data: category } = await supabase
      .from("categories")
      .select("kind, archived_at")
      .eq("id", category_id)
      .eq("wallet_id", wallet_id)
      .single();
    if (!category || category.archived_at) return { error: "Choose a category" };
    if (category.kind !== kind) {
      return { error: "That category doesn't match this transaction type" };
    }
  }

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

  // Built field by field, not `{ ...parsed.data }` — the same discipline
  // setDeletedAt's UPDATE follows below. wallet_id and kind aren't in
  // parsed.data (the schema never names them) and recurring_occurrence_on
  // isn't either, but kind IS in `authenticated`'s effective UPDATE grant
  // (0004_rls.sql, never revoked by 0016) — the schema's omission plus this
  // explicit, named payload are the only two things keeping it out of the
  // statement.
  const { data: updated, error } = await supabase
    .from("transactions")
    .update({
      amount_minor: signedAmount(kind, magnitude),
      category_id,
      occurred_on,
      note,
      merchant,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");

  if (error) return { error: "Could not save transaction. Please try again." };
  // A zero-row UPDATE is not a Postgres error — archiveWallet and
  // archiveCategory both make this same check, and both exist because this
  // codebase has shipped the "reported success, database untouched" bug
  // before.
  if (!updated || updated.length === 0) return { error: "Transaction not found" };

  revalidatePath("/", "layout");
  return { ok: true };
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

  // Archived wallets are rejected here for the identical reason
  // createTransaction's wallet lookup rejects them (see that check's doc
  // comment above): a transfer leg is a new transaction, and archiving a
  // wallet is meant to remove it from every place a NEW transaction could
  // reference it, not just single-leg expense/income entry. Half-applying
  // that rule (rejecting it in createTransaction but not here) would leave
  // an archived wallet reachable as a transfer endpoint — a gap the two
  // functions being separate silently created despite sharing the same
  // "Wallet not found" reasoning.
  const { data: wallets } = await supabase
    .from("wallets")
    .select("id, currency_code, archived_at")
    .in("id", [from_wallet_id, to_wallet_id]);
  const from = wallets?.find((w) => w.id === from_wallet_id);
  const to = wallets?.find((w) => w.id === to_wallet_id);
  if (!from || !to || from.archived_at || to.archived_at) return { error: "Wallet not found" };

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
 * Edits an existing transfer — both legs together, via the
 * `update_transfer_pair` RPC (supabase/migrations/0016_editable_transactions.sql).
 *
 * **Why an RPC, not two `.update()` calls from here.** A transfer is a PAIR
 * of rows sharing `transfer_id` with opposite-signed `amount_minor`
 * (0003_transactions.sql's `transfer_shape`/`non_transfer_no_link` CHECKs).
 * Editing the amount has to change BOTH rows' magnitude while preserving
 * each row's own sign — PostgREST cannot express a `CASE` inside a single
 * `.update()` call, so that alone rules out one statement from the client.
 * Two separate client-side `.update()` calls were the other option this
 * task's brief floated, and they were rejected: each is its own HTTP
 * request and its own Postgres transaction, so they are not atomic — a
 * request that failed (network blip, connection drop) between the first
 * `.update()` and the second would leave one leg re-dated/re-amounted and
 * the other leg untouched, silently making money appear or vanish. That is
 * the exact corruption this task exists to prevent, so "handle a partial
 * failure by rolling the first one back from application code" is not a
 * real answer — there is no way to guarantee that rollback itself runs.
 * Wrapping both writes in one PL/pgSQL statement (`update_transfer_pair`)
 * makes them one Postgres transaction, the same way `create_transfer`
 * (0005_transfer_fn.sql) already solved the identical problem for the
 * INSERT side — this function is that precedent's UPDATE counterpart, and
 * `security invoker` for the same reason: it must run under the caller's
 * own `transactions_member` RLS and column-scoped UPDATE grant
 * (0004_rls.sql, extended by 0016), not with elevated rights.
 *
 * **`amount_out`/`amount_in`, mirroring `create_transfer` exactly (fix
 * round 1).** The original version of this function took a single shared
 * `amount` — a defect in `transferEditInput` (Task 2), not something this
 * function could correctly work around: `create_transfer` takes independent
 * `amount_out`/`amount_in` bigints because a cross-currency transfer's two
 * legs are genuinely different amounts in different currencies, while a
 * same-currency transfer must additionally balance. A single shared amount
 * can only ever express the same-currency case, so the original version
 * refused every edit to a cross-currency transfer — not just its amount,
 * its date/note/merchant too, since `amount` was required with no "leave
 * this alone" option. `transferEditInput` now carries both fields (that
 * schema's own doc comment has the full defect writeup), and this function
 * no longer needs its own currency-mismatch guard: the balance invariant
 * that guard existed to protect now lives in `update_transfer_pair` itself,
 * which protects the EDIT path the way `create_transfer` protects the
 * CREATE path — neither is the only thing that can move `amount_minor`.
 * 0004_rls.sql:83 grants `update (amount_minor)` on `transactions`
 * table-wide, so a member can unbalance a pair with an ordinary PATCH to
 * one leg, no RPC involved at all; the database as a whole does not
 * guarantee a transfer stays balanced. `update_transfer_pair` raises
 * `'a same-currency transfer must balance'` — the exact string
 * `create_transfer` already raises, so no change was needed to
 * `KNOWN_TRANSFER_ERRORS` below to forward it.
 *
 * A lookup precedes the RPC call (`.eq("transfer_id", ...).is("deleted_at",
 * null)`, no `.select("id")`/`.single()` — a transfer is always exactly two
 * rows) for two reasons: it is what makes each amount's precision/parsing
 * currency-aware at all (a leg's `currency_code` has to come from
 * somewhere, and `amount_out`/`amount_in` are parsed against the OUTGOING
 * and INCOMING leg's own currency respectively, read by sign off the rows —
 * never assumed to be the same currency, unlike the original version), and
 * it fails fast with a readable error before ever calling the RPC. It is
 * NOT a substitute for the RPC's own `deleted_at is null` filter and
 * exactly-two-rows check below — a delete racing between the lookup and
 * the RPC call must still land on "not found," not a stray write to a row
 * the user believes is gone, exactly like `updateTransaction`'s identical
 * two-checkpoint reasoning.
 */
export async function updateTransfer(input: TransferEditInput): Promise<MutationResult> {
  const parsed = transferEditInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { transfer_id, amount_out, amount_in, occurred_on, note, merchant } = parsed.data;

  // `transactions_member` RLS means this only ever sees legs the caller is
  // a member of — a caller who has lost membership on one of the two
  // wallets since the transfer was created sees fewer than two rows here,
  // the same "incomplete pair" outcome as a genuinely missing/foreign
  // transfer_id, and is refused for the identical reason: this action must
  // never touch one leg of a pair without the other.
  const { data: legs } = await supabase
    .from("transactions")
    .select("amount_minor, currency_code")
    .eq("transfer_id", transfer_id)
    .is("deleted_at", null);
  if (!legs || legs.length !== 2) return { error: "Transfer not found" };

  // Which leg is "out" (amount_out applies) and which is "in" (amount_in
  // applies) is read from each row's OWN current sign, never guessed from
  // array order — the identical discipline update_transfer_pair's own CASE
  // follows for the actual write. A malformed pair (both legs the same
  // sign — nothing in the schema's CHECK constraints rules that out, only
  // `create_transfer` itself ever producing opposite signs) is reported as
  // "not found" rather than silently misapplied to the wrong leg.
  const outLeg = legs.find((l) => l.amount_minor < 0);
  const inLeg = legs.find((l) => l.amount_minor > 0);
  if (!outLeg || !inLeg) return { error: "Transfer not found" };

  const outMinorUnit = minorUnitFor(outLeg.currency_code);
  const outPrecisionIssue = precisionError(amount_out, outMinorUnit, outLeg.currency_code);
  if (outPrecisionIssue) return { error: outPrecisionIssue };

  const inMinorUnit = minorUnitFor(inLeg.currency_code);
  const inPrecisionIssue = precisionError(amount_in, inMinorUnit, inLeg.currency_code);
  if (inPrecisionIssue) return { error: inPrecisionIssue };

  let outMagnitude: number;
  let inMagnitude: number;
  try {
    outMagnitude = parseAmountInput(amount_out, outMinorUnit);
    inMagnitude = parseAmountInput(amount_in, inMinorUnit);
  } catch {
    return { error: "That amount isn't valid" };
  }
  if (outMagnitude === 0 || inMagnitude === 0) {
    return { error: "Enter an amount greater than zero" };
  }

  // Built field by field and named explicitly, matching updateTransaction's
  // own discipline — there is no `category_id` (or `wallet_id`/`kind`) to
  // spread in the first place, since transferEditInput never carries one
  // (that schema's own doc comment: the transfer_shape CHECK forces a
  // transfer's category_id to null), so this call can never put one on
  // the wire no matter what `parsed.data` contains. The same-currency
  // balance check is deliberately NOT duplicated here — see this
  // function's own doc comment above for why that invariant lives in
  // update_transfer_pair alone.
  //
  // `note ?? undefined` / `merchant ?? undefined`: the same codegen quirk
  // createTransfer's own `note: note || undefined` comment already covers —
  // `p_note`/`p_merchant` are `text default null` SQL parameters, but
  // Supabase's generated Args type maps a defaulted parameter to an
  // OPTIONAL TS property (`p_note?: string`), not a nullable one. An
  // omitted key, once JSON-serialized, reaches Postgres exactly the way an
  // absent argument would — the function's own `default null` takes over —
  // so this is equivalent to sending `null` explicitly, just typed
  // correctly. Unlike createTransfer's `note || undefined` (which also
  // treats an empty string as "omit"), this is `?? undefined`: `note`/
  // `merchant` here are already `string | null` (transferEditInput's
  // `editableText` already turned a blank string into `null` during
  // parsing), so there is no remaining falsy-but-meaningful case to fold in.
  const { data: updated, error } = await supabase.rpc("update_transfer_pair", {
    p_transfer_id: transfer_id,
    p_amount_out: outMagnitude,
    p_amount_in: inMagnitude,
    p_occurred_on: occurred_on,
    p_note: note ?? undefined,
    p_merchant: merchant ?? undefined,
  });

  if (error) {
    // update_transfer_pair raises the identical strings create_transfer
    // does for the null/positivity/balance guards (this function's own doc
    // comment) — already covered by KNOWN_TRANSFER_ERRORS, so forwarding
    // them here is the same allowlisted, no-raw-provider-text path
    // createTransfer already uses, not a new hole.
    return {
      error: KNOWN_TRANSFER_ERRORS.has(error.message)
        ? error.message
        : "Could not save transfer. Please try again.",
    };
  }
  // A zero- or one-row result is not a Postgres error — same
  // reported-success-database-untouched concern archiveWallet,
  // archiveCategory and updateTransaction's own check all guard against.
  // Exactly two rows, never fewer, never more (transfer_id is never reused
  // across pairs — 0005_transfer_fn.sql's create_transfer always mints a
  // fresh one), or this pair is reported incomplete rather than "fixed."
  if (!updated || updated.length !== 2) {
    return { error: "Could not update both legs of this transfer. Please try again." };
  }

  revalidatePath("/", "layout");
  return { ok: true };
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
  if (error) {
    // 23505 unique_violation on transactions_recurring_occurrence (the
    // partial unique index supabase/migrations/0015_recurring.sql adds,
    // moved by 0016_editable_transactions.sql onto (recurring_id,
    // recurring_occurrence_on) -- the occurrence's SCHEDULED date, not its
    // occurred_on -- where recurring_id is not null and deleted_at is
    // null) can only fire on a RESTORE (value === null, i.e. this is
    // restoreTransaction): the index's own predicate excludes soft-deleted
    // rows, so a soft DELETE always transitions a row OUT of it and can
    // never collide, while un-deleting can newly collide with a live
    // sibling that already occupies the same (recurring_id,
    // recurring_occurrence_on) pair. Real path this closes: a recorded
    // rent row is deleted, the same occurrence is recorded again from the
    // recurring card, and the user taps Undo on the ORIGINAL delete toast
    // — without this branch that produced the generic message below,
    // which gave no hint the row was unrecoverable via Undo and no path
    // to fix it. This logic needs no change for the split -- both the
    // deleted row and its live replacement still share the same
    // recurring_occurrence_on regardless of what either one's occurred_on
    // says, so the collision this branch explains still fires exactly
    // when it used to.
    if (error.code === "23505") {
      return {
        error: "This occurrence has already been recorded again, so the deleted copy can't be restored.",
      };
    }
    return { error: "Could not update transaction" };
  }
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
