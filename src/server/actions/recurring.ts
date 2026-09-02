"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { recurringInput, type RecurringField } from "@/lib/validation/recurring";
import { parseAmountInput, minorUnitFor } from "@/lib/money";
import { signedAmount, nonTransferKind } from "@/lib/validation/transaction";
import { occurrencesFor } from "@/lib/recurrence";
import { todayLocalDate } from "@/lib/today";
import { z } from "zod";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type RecurringState = { error?: string; field?: RecurringField };

/** Which field a failed parse's first issue is about, for `aria-invalid` —
 * identical in shape to src/server/actions/wallets.ts's `firstIssueField`. */
function firstIssueField(error: z.ZodError): RecurringField | undefined {
  const path = error.issues[0]?.path[0];
  return typeof path === "string" ? (path as RecurringField) : undefined;
}

/**
 * Server Functions are reachable via direct POST requests, not just
 * through this app's forms (see node_modules/next/dist/docs/01-app/
 * 02-guides/data-security.md and .../server-actions.md, "Authentication and
 * authorization"), so every action below re-derives the caller from the
 * session itself and re-validates `formData` with zod rather than trusting
 * either the render-time auth gate or the client — same convention as
 * src/server/actions/wallets.ts.
 *
 * `created_by` is never accepted from the client (`recurringInput` has no
 * such field) — it always comes from `supabase.auth.getUser()`. `wallet_id`
 * IS accepted from the client on create only (a rule, like a category,
 * belongs to a wallet rather than a single user — supabase/migrations/
 * 0015_recurring.sql), and its trustworthiness is enforced by
 * `recurring_rules_member` RLS (`is_wallet_member(wallet_id)`), which is the
 * gate that actually stops a POST naming a wallet the caller doesn't belong
 * to — the insert below simply fails and reports the same generic error any
 * other database failure would.
 *
 * `updateRule` and `archiveRule` never write `wallet_id` or `created_by` in
 * their payloads, matching what 0015 actually grants: `revoke update ...
 * from authenticated; grant update (name, kind, amount_minor,
 * currency_code, category_id, interval_unit, anchor_on, ends_on,
 * archived_at, updated_at) on recurring_rules to authenticated` omits both
 * columns on purpose (moving a rule between wallets, or re-attributing it
 * to someone else, is not a feature this migration builds) — attempting to
 * write either is not merely redundant, it is a privilege the database
 * itself denies, so the UPDATE would fail outright.
 */

/**
 * Turns a validated `amount` string plus `kind` into the signed
 * `amount_minor` the CHECK constraints require (`rule_expense_is_negative`,
 * `rule_income_is_positive` — supabase/migrations/0015_recurring.sql),
 * mirroring src/server/actions/transactions.ts's identical `createTransaction`
 * sequence: parse to a positive magnitude first (rejecting a fraction the
 * currency can't hold happens earlier, in `recurringInput`'s own
 * superRefine), reject a zero amount explicitly (`signedAmount` itself
 * throws on `<= 0`, but a thrown error inside a Server Function is masked
 * to an opaque digest in production — this file's own convention, and
 * wallets.ts's, is to catch and translate before that ever happens), then
 * apply the sign from `kind` via `signedAmount` — reused directly from
 * transaction.ts rather than reimplemented, since `RecurringInput["kind"]`
 * ("expense" | "income") is already a subset of the `TxnKind` that function
 * accepts.
 */
function toSignedMinor(
  amount: string,
  currencyCode: string,
  kind: "expense" | "income",
): { minor: number } | { error: string } {
  let magnitude: number;
  try {
    magnitude = parseAmountInput(amount, minorUnitFor(currencyCode));
  } catch {
    return { error: "That amount isn't valid" };
  }
  if (magnitude === 0) return { error: "Enter an amount greater than zero" };
  return { minor: signedAmount(kind, magnitude) };
}

/**
 * Verifies the chosen category belongs to the rule's own wallet, is not
 * archived, and its `kind` agrees with the rule's `kind` — mirroring
 * src/server/actions/transactions.ts's `createTransaction` (its comment
 * block above `.from("categories")`) closely, including its exact
 * "Choose a category" wording.
 *
 * The KIND-mismatch message does NOT copy `createTransaction`'s wording
 * verbatim, unlike "Choose a category" above. It originally did ("That
 * category doesn't match this transaction type"), on the theory that
 * identical text is what a user sees "whichever form caught the same
 * mistake" — but that theory was written before /recurring (Task 5)
 * existed, when this action's only caller was implicitly assumed to be a
 * transaction-shaped form. /recurring's own copy never says "transaction"
 * anywhere else on the screen, and a rule is not one (spec §1.2 draws that
 * distinction explicitly) — so the verbatim-match benefit (consistency
 * across the two forms) was actually costing contextual accuracy on this
 * one. "That category doesn't match this type" says the same thing without
 * asserting a noun this screen never uses.
 *

 * Both checks exist for the same reason 0015's own
 * `recurring_rules_category_same_wallet` FK exists: a rule that PASSES
 * creation/edit but can never be recorded is a worse failure than a
 * rejected form, because it strands the user far from the form that
 * actually caused it — every later attempt to record an occurrence would
 * insert a transaction with this rule's fixed kind and category, and
 * `createTransaction`'s own identical checks would refuse it, every single
 * time. `category_kind` and `txn_kind` are distinct Postgres enum types
 * (0002 vs 0003), so the composite-FK mechanism that already protects
 * cross-wallet categories cannot be extended to also protect kind — this
 * check is the only practical place left to catch it.
 *
 * Archived is rejected here on BOTH create and edit — a deliberate choice,
 * not merely mirroring transactions.ts (whose own comment defers the
 * archived-on-edit question as "a different, not-yet-built action" for a
 * *transaction*, which records something that already happened). A
 * recurring rule is different: it exists entirely to be recorded again in
 * the future, so "hides it from pickers" for anything NEW (spec §5.3)
 * applies to every write that keeps a rule pointed at an archived category,
 * not just its first — saving an edit that leaves one in place would strand
 * the rule exactly as permanently un-recordable as a kind mismatch would.
 *
 * Scoped by `.eq("wallet_id", walletId)`, like `createTransaction`'s
 * identical query: `categories_member` RLS stops a stranger's category but
 * not a cross-wallet one of the caller's own, so without this the category
 * would reach the write and die on 0015's `recurring_rules_category_same_wallet`
 * FK instead, surfacing as the generic "Could not create/update rule"
 * message rather than this actionable one.
 */
async function checkCategory(
  supabase: SupabaseServerClient,
  categoryId: string,
  walletId: string,
  kind: "expense" | "income",
): Promise<RecurringState | null> {
  const { data: category } = await supabase
    .from("categories")
    .select("kind, archived_at")
    .eq("id", categoryId)
    .eq("wallet_id", walletId)
    .single();
  if (!category || category.archived_at) return { error: "Choose a category", field: "category_id" };
  if (category.kind !== kind) {
    return { error: "That category doesn't match this type", field: "category_id" };
  }
  return null;
}

/**
 * Verifies a wallet's OWN currency agrees with the currency a rule proposes
 * to carry — spec §4's third re-validation for Record ("the wallet's
 * currency matches the rule's"), applied here at Create/Edit time too so the
 * user learns about a mismatch at the form that caused it rather than only
 * at Record, the same "stranded far from the form" shape `checkCategory`'s
 * own doc comment describes for Task 2's cross-wallet category bug and Task
 * 3's kind mismatch.
 *
 * This check exists at all because `recurringInput.currency_code` is a free
 * field, unlike `createTransaction`, which never accepts a currency from the
 * caller and instead always writes the WALLET's own — manual entry is
 * therefore structurally unable to produce this mismatch, while a recurring
 * rule can (fix round 1, Critical finding): nothing in `recurringInput`'s
 * Zod schema or in `0015_recurring.sql`'s CHECK constraints ties a rule's
 * currency to its wallet's, so a rule saved with the wrong one sits
 * un-recordable forever, and — proven live by the reviewer — a mismatched
 * rule that WAS recorded corrupts `get_wallet_balances` silently, because
 * that view sums `amount_minor` across every currency with no filter and
 * labels the total with the wallet's own code.
 *
 * Refuses rather than substituting the wallet's currency for the rule's:
 * silently re-denominating the amount (treating a JPY figure as the
 * wallet's SGD, say) would misprice the rule by orders of magnitude and is
 * worse than leaving the rule un-recordable.
 *
 * `"Wallet not found"` on a missing row mirrors `createTransaction`'s own
 * wallet lookup (`transactions.ts`, its comment on the archived-wallet
 * check) for the identical reason there: `createRule`'s `walletId` is
 * caller-supplied form input, exactly like `createTransaction`'s, so the
 * uniform message applies here — this is NOT `recordOccurrence`'s situation
 * (an RLS-scoped, already-owned rule), where a more specific message is
 * safe. See `recordOccurrence`'s own wallet check for why those two cases
 * are allowed to differ.
 */
async function checkWalletCurrency(
  supabase: SupabaseServerClient,
  walletId: string,
  currencyCode: string,
): Promise<RecurringState | null> {
  const { data: wallet } = await supabase
    .from("wallets")
    .select("currency_code")
    .eq("id", walletId)
    .single();
  if (!wallet) return { error: "Wallet not found" };
  if (wallet.currency_code !== currencyCode) {
    return {
      error: `This wallet's currency is ${wallet.currency_code}, not ${currencyCode}.`,
      field: "currency_code",
    };
  }
  return null;
}

/**
 * Creates a recurring rule. Not consumed by any page yet — this task builds
 * validation and the actions themselves; a later task wires up the /recurring
 * form and the "record an occurrence" flow described in the design spec.
 */
export async function createRule(
  _prev: RecurringState,
  formData: FormData,
): Promise<RecurringState> {
  const parsed = recurringInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message, field: firstIssueField(parsed.error) };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { wallet_id, name, kind, amount, currency_code, category_id, interval_unit, anchor_on, ends_on } =
    parsed.data;

  const currencyError = await checkWalletCurrency(supabase, wallet_id, currency_code);
  if (currencyError) return currencyError;

  const categoryError = await checkCategory(supabase, category_id, wallet_id, kind);
  if (categoryError) return categoryError;

  const signed = toSignedMinor(amount, currency_code, kind);
  if ("error" in signed) return { error: signed.error, field: "amount" };

  const { error } = await supabase.from("recurring_rules").insert({
    wallet_id,
    created_by: user.id,
    name,
    kind,
    amount_minor: signed.minor,
    currency_code,
    category_id,
    interval_unit,
    anchor_on,
    ends_on,
  });
  // This schema has no user-actionable constraint beyond what
  // `recurringInput` already checks and the membership/category-wallet FK
  // enforce (see this file's module doc comment) — a raw Postgres error
  // here could only leak implementation detail, never useful guidance, so
  // it is never forwarded (same convention as wallets.ts/categories.ts).
  if (error) return { error: "Could not create rule. Please try again." };

  revalidatePath("/", "layout");
  revalidatePath("/recurring");
  return {};
}

/**
 * Edits an existing rule's descriptive/schedule fields. `wallet_id` is part
 * of `recurringInput` (shared with `createRule`, which needs it) but is
 * deliberately excluded from the UPDATE payload below — see this file's
 * module doc comment for why that exclusion is load-bearing, not
 * incidental: the database's own column-scoped UPDATE grant denies writing
 * it at all, so a caller who somehow reached this action with a different
 * `wallet_id` in the form would have the write refused, not silently
 * ignored, if this code attempted to include it.
 */
export async function updateRule(
  id: string,
  _prev: RecurringState,
  formData: FormData,
): Promise<RecurringState> {
  const parsed = recurringInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message, field: firstIssueField(parsed.error) };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { name, kind, amount, currency_code, category_id, interval_unit, anchor_on, ends_on } = parsed.data;

  // The rule's OWN wallet_id, never the posted one: wallet_id cannot be
  // changed via UPDATE (this file's module doc comment — the database's
  // own column-scoped grant denies writing it at all), so trusting a
  // client-supplied wallet_id here would validate the category against a
  // value that might not even be what is actually stored. This SELECT is
  // itself scoped by `recurring_rules_member` RLS, so it doubles as the
  // existence/membership check — a rule the caller can't see comes back
  // `null` here and is reported "Rule not found" immediately, rather than
  // surfacing later as an opaque category-lookup miss.
  const { data: rule } = await supabase
    .from("recurring_rules")
    .select("wallet_id")
    .eq("id", id)
    .single();
  if (!rule) return { error: "Rule not found" };

  const currencyError = await checkWalletCurrency(supabase, rule.wallet_id, currency_code);
  if (currencyError) return currencyError;

  const categoryError = await checkCategory(supabase, category_id, rule.wallet_id, kind);
  if (categoryError) return categoryError;

  const signed = toSignedMinor(amount, currency_code, kind);
  if ("error" in signed) return { error: signed.error, field: "amount" };

  // The affected-row count is checked, not assumed — `.select("id")` makes
  // the UPDATE return what it actually changed. Zero affected rows is not
  // an error in Postgres, and PostgREST reports none: a nonexistent id and
  // an id the caller isn't a member of (recurring_rules_member RLS makes
  // that UPDATE match nothing) both land here the same way, and get the
  // same "not found" message — same shape as src/server/actions/wallets.ts's
  // `archiveWallet` and categories.ts's `archiveCategory`.
  const { data, error } = await supabase
    .from("recurring_rules")
    .update({
      name,
      kind,
      amount_minor: signed.minor,
      currency_code,
      category_id,
      interval_unit,
      anchor_on,
      ends_on,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id");
  if (error) return { error: "Could not update rule. Please try again." };
  if (!data || data.length === 0) return { error: "Rule not found" };

  revalidatePath("/", "layout");
  revalidatePath("/recurring");
  return {};
}

/**
 * Soft-deletes (archives) a rule — never a hard delete, matching every
 * other archive action in this codebase (wallets.ts's `archiveWallet`,
 * categories.ts's `archiveCategory`): 0015's `transactions_recurring_same_wallet`
 * FK is `on delete set null (recurring_id)`, not cascade, specifically so a
 * deleted rule never takes recorded history with it — archiving preserves
 * both the rule (for that FK to still point at) and its transactions.
 *
 * No per-caller ownership column to filter the query on: unlike
 * `archiveWallet`'s `.eq("owner_id", user.id)`, `recurring_rules` has no
 * such column (only `wallet_id`, shared by every member, and `created_by`,
 * which is `on delete set null` and can legitimately be null) — so, exactly
 * like categories.ts's `archiveCategory`, RLS (`recurring_rules_member`) is
 * the only gate here, not defense-in-depth on top of one.
 *
 * The affected-row count is checked the same way `archiveWallet` and
 * `archiveCategory` check theirs: a zero-row UPDATE is not an error in
 * Postgres, and without this check the UI would report success while
 * nothing had changed — a defect this codebase has already been bitten by
 * twice (wallets.ts's and categories.ts's own doc comments).
 */
export async function archiveRule(id: string): Promise<RecurringState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { data, error } = await supabase
    .from("recurring_rules")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return { error: "Could not archive rule. Please try again." };
  if (!data || data.length === 0) return { error: "Rule not found" };

  revalidatePath("/", "layout");
  revalidatePath("/recurring");
  return {};
}

/**
 * Records one occurrence of a recurring rule as a real transaction, dated to
 * the OCCURRENCE (`occurrenceOn`) rather than to today -- the entire premise
 * spec §1.3 rests on ("each occurrence lands on its own date") is cosmetic
 * unless the row itself carries the date it actually happened on: July's
 * rent recorded in September must produce a 1 July transaction, not a 1
 * September one. `occurred_on` is set directly from the caller's argument,
 * never from `new Date()`.
 *
 * The rule is loaded scoped by RLS (`recurring_rules_member`), the same
 * pattern `updateRule` uses: a rule the caller can't see comes back `null`
 * here and is reported "Rule not found" rather than surfacing later as an
 * opaque insert failure. Re-validates exactly the three things spec §4 lists
 * for Record, each mirroring what manual entry (`transactions.ts`) already
 * validates for the identical reason -- the rule's wallet, category or
 * currency pairing can all have drifted out of agreement at any point AFTER
 * the rule was created, and the composite FKs/CHECKs alone would only
 * surface that as a raw constraint violation (or, for currency, nothing at
 * all -- see `checkWalletCurrency`'s doc comment) at insert time:
 *
 * - the wallet is active (`wallet.archived_at`);
 * - the category's kind matches (`checkCategory`, reused rather than
 *   reimplemented, exactly as `createRule`/`updateRule` do);
 * - the wallet's currency matches the rule's (`checkWalletCurrency`'s sibling
 *   check, inlined here rather than calling that helper directly, since this
 *   function already needs `archived_at` off the same wallet row and a
 *   second SELECT would be redundant).
 *
 * Unlike `createTransaction`'s wallet check -- which reports a uniform
 * "Wallet not found" for both a nonexistent wallet and an archived one,
 * deliberately, so an adversarial direct POST naming an arbitrary wallet id
 * learns nothing about wallets it can't otherwise see -- this check can
 * safely name "archived" specifically: the rule itself only reached this
 * point via an RLS-scoped SELECT the caller already passed, so the caller
 * already knows this wallet exists and that they belong to it. There is no
 * adversarial party being told anything new, and a clearer message is more
 * useful than the uniform one would be here. The `!wallet` branch is kept
 * separate from the `archived_at` branch (fix round 1) because they are not
 * the same fact: a missing row here means the lookup itself failed (a
 * transient error, or data corruption), never "this wallet is archived",
 * and reporting the latter for the former would be false and unactionable.
 *
 * `occurrenceOn` is shape-validated with `z.iso.date()` (fix round 1,
 * Important finding) -- the same reasoning `transaction.ts`'s `occurred_on`
 * and this file's own `anchor_on`/`ends_on` already carry: a bare
 * `\d{4}-\d{2}-\d{2}` regex lets a calendar-invalid string like
 * `"2026-02-30"` through to Postgres as a raw driver error. It is then
 * checked against the schedule itself: the rule's own `archived_at` is
 * refused (a paused rule -- spec §5's "pause" -- stays fully recordable by
 * direct POST otherwise), and `occurrenceOn` must appear in
 * `occurrencesFor`'s output for `{anchorOn, intervalUnit, endsOn}` as of the
 * server's own `today` (`todayLocalDate`, src/lib/today.ts) -- `occurrencesFor`
 * is the most heavily tested function on this branch (35 tests, brute-force
 * cross-checked), so this leans on it rather than reimplementing any part of
 * the schedule logic. This closes the future-occurrence gap: without it,
 * recording a date the rule has not reached yet makes the ledger assert
 * October's rent was paid in September, contradicting spec §1.1 ("balance
 * keeps meaning money that actually moved") and §3.3 ("Occurrences are never
 * generated in the future") -- reachable from a stale tab or a
 * clock-skewed client, not only by malice. It is NOT a cross-tenant hole
 * either way: bounded to the caller's own (RLS-scoped) wallet, and the slot
 * is never permanently consumed (the unique index's predicate is
 * `deleted_at is null`).
 *
 * Postgres `23505` (the partial unique index `transactions_recurring_
 * occurrence` on `(recurring_id, occurred_on) where recurring_id is not
 * null and deleted_at is null`) is translated to a readable "already
 * recorded" message rather than surfaced verbatim -- the index exists
 * precisely to absorb a double tap, a retried request, or a second tab, and
 * the user needs to see that the occurrence is already in the ledger, not a
 * driver error. This mapping is safe only because `transactions` currently
 * has exactly one OTHER unique constraint (`transactions_pkey`, on `id`,
 * which this insert cannot violate) -- a future unique index added to this
 * table would need this branch revisited, since `23505` alone doesn't say
 * which index fired.
 */
export async function recordOccurrence(ruleId: string, occurrenceOn: string): Promise<RecurringState> {
  const dateCheck = z.iso.date().safeParse(occurrenceOn);
  if (!dateCheck.success) return { error: "Enter a valid date" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { data: rule } = await supabase
    .from("recurring_rules")
    .select("wallet_id, kind, amount_minor, currency_code, category_id, anchor_on, interval_unit, ends_on, archived_at")
    .eq("id", ruleId)
    .single();
  if (!rule) return { error: "Rule not found" };
  if (rule.archived_at) return { error: "This rule has been paused." };

  // `recurring_rules.kind` is DB-typed as the full `txn_kind` enum
  // (expense|income|transfer), same as `transactions.kind` — the generated
  // Supabase types have no way to encode 0015's own `rule_kind_not_transfer`
  // CHECK constraint, which is what actually guarantees this value is never
  // "transfer". Re-parsing with `nonTransferKind` (rather than an unchecked
  // cast) turns "the database enforced this" into a checked fact
  // `checkCategory` can rely on, the same defence-in-depth reasoning this
  // file already applies via `checkCategory` itself. A failed parse here
  // means the row itself is malformed (not that it's missing — `!rule`
  // above already handled that), so it gets its own message rather than
  // reusing "Rule not found".
  const kindParsed = nonTransferKind.safeParse(rule.kind);
  if (!kindParsed.success) return { error: "This rule's data is invalid and can't be recorded." };
  const kind = kindParsed.data;

  // `archivedAt` is passed through for defence in depth even though the
  // `rule.archived_at` check above already returns before this line is ever
  // reached for a paused rule (fix round 2, I1) — this keeps the schedule
  // computed here in permanent agreement with `due-rows.ts`'s, rather than
  // relying on the early return above to be the ONLY place that fact is
  // honoured.
  const schedule = occurrencesFor(
    {
      anchorOn: rule.anchor_on,
      intervalUnit: rule.interval_unit,
      endsOn: rule.ends_on,
      archivedAt: rule.archived_at,
    },
    todayLocalDate(),
  );
  if (!schedule.dates.includes(occurrenceOn)) {
    return { error: "That date isn't a due occurrence of this rule." };
  }

  const { data: wallet } = await supabase
    .from("wallets")
    .select("currency_code, archived_at")
    .eq("id", rule.wallet_id)
    .single();
  if (!wallet) return { error: "Could not look up this rule's wallet. Please try again." };
  if (wallet.archived_at) return { error: "This wallet has been archived." };
  if (wallet.currency_code !== rule.currency_code) {
    return {
      error: `This rule's currency (${rule.currency_code}) doesn't match the wallet's currency (${wallet.currency_code}).`,
    };
  }

  const categoryError = await checkCategory(supabase, rule.category_id, rule.wallet_id, kind);
  if (categoryError) {
    // `checkCategory`'s "Choose a category" wording assumes a screen with a
    // picker to redirect the user to — `createRule`/`updateRule` both have
    // one; the Record surface (a due-items list) does not. Spec §4: a
    // rule's due items "render with the reason stated", so this path gets
    // its own wording for the archived case (the only realistic way
    // `checkCategory` fails here without also being a kind mismatch, which
    // already has its own distinct message — `category_id` is `on delete
    // restrict`, so a category this rule references cannot have been
    // deleted out from under it, only archived).
    return categoryError.error === "Choose a category"
      ? { error: "This rule's category has been archived." }
      : categoryError;
  }

  const { error } = await supabase.from("transactions").insert({
    wallet_id: rule.wallet_id,
    created_by: user.id,
    kind,
    amount_minor: rule.amount_minor,
    currency_code: rule.currency_code,
    category_id: rule.category_id,
    occurred_on: occurrenceOn,
    recurring_id: ruleId,
    note: null,
  });
  if (error) {
    if (error.code === "23505") return { error: "This occurrence is already recorded." };
    return { error: "Could not record this occurrence. Please try again." };
  }

  revalidatePath("/", "layout");
  return {};
}

/**
 * Marks one occurrence as explicitly declined, by inserting into
 * `recurring_skips`. The composite primary key `(rule_id, occurrence_on)`
 * IS the idempotency guarantee (0015's own comment on the table): a second
 * skip of the same period raises `23505`, which is treated as SUCCESS here
 * rather than an error -- the caller asked for a state ("this period is
 * skipped") they are already in, and reporting that as a failure would be
 * wrong, not merely unhelpful.
 *
 * No separate rule-existence/membership check is needed before the insert:
 * `recurring_skips_member`'s `WITH CHECK` (0015) already fails a rule the
 * caller can't see with `42501`, which is neither `undefined` nor `23505`
 * and so falls through to the generic error below -- correct, since a
 * caller with no route to a rule shouldn't be told the difference between
 * "no such rule" and "not your rule" any more than the RLS policy itself
 * reveals it.
 *
 * Treating `23505` as success is safe only because `recurring_skips`
 * currently has exactly one unique constraint -- its own composite primary
 * key `(rule_id, occurrence_on)`, the very idempotency guarantee this
 * function relies on. A future unique index added to this table would need
 * this branch revisited, since `23505` alone doesn't say which constraint
 * fired.
 *
 * `occurrenceOn` is shape-validated with `z.iso.date()` (fix round 2, small
 * finding) -- `recordOccurrence` already carries this exact check (see that
 * function's own doc comment); this one didn't, so a bare
 * `\d{4}-\d{2}-\d{2}`-shaped-but-calendar-invalid string (`"2026-02-30"`)
 * reached Postgres as a raw driver error instead of this file's own
 * translated messages.
 */
export async function skipOccurrence(ruleId: string, occurrenceOn: string): Promise<RecurringState> {
  const dateCheck = z.iso.date().safeParse(occurrenceOn);
  if (!dateCheck.success) return { error: "Enter a valid date" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { error } = await supabase.from("recurring_skips").insert({
    rule_id: ruleId,
    occurrence_on: occurrenceOn,
    created_by: user.id,
  });
  if (error && error.code !== "23505") {
    return { error: "Could not skip this occurrence. Please try again." };
  }

  revalidatePath("/", "layout");
  return {};
}

/**
 * Reverses `skipOccurrence` by deleting that row. Symmetric with the skip
 * side's idempotence: deleting a row that doesn't exist (already unskipped,
 * or never skipped) affects zero rows without Postgres raising an error, and
 * that is treated as success too -- the caller again ends up in the state
 * they asked for ("this period is not skipped"), which un-skipping an
 * already-unskipped period already is.
 */
export async function unskipOccurrence(ruleId: string, occurrenceOn: string): Promise<RecurringState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { error } = await supabase
    .from("recurring_skips")
    .delete()
    .eq("rule_id", ruleId)
    .eq("occurrence_on", occurrenceOn);
  if (error) return { error: "Could not undo the skip. Please try again." };

  revalidatePath("/", "layout");
  return {};
}
