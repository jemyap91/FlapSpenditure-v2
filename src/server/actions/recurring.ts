"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { recurringInput, type RecurringField } from "@/lib/validation/recurring";
import { parseAmountInput, minorUnitFor } from "@/lib/money";
import { signedAmount } from "@/lib/validation/transaction";
import type { z } from "zod";

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
 * "Choose a category" / "That category doesn't match this transaction
 * type" wording, so a user sees identical text whichever form caught the
 * same mistake.
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
    return { error: "That category doesn't match this transaction type", field: "category_id" };
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
