"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { walletInput, type WalletField } from "@/lib/validation/wallet";
import { parseAmountInput, minorUnitFor } from "@/lib/money";
import type { z } from "zod";

export type WalletState = { error?: string; field?: WalletField };

/** Which field a failed parse's first issue is about, for `aria-invalid` —
 * same idea as src/lib/validation/auth.ts's `credentialsValidationError`,
 * but simpler: unlike auth, wallet validation messages are already safe to
 * show verbatim (no enumeration-oracle concern), so only the field needs
 * mapping out of the zod error, not the message text too. */
function firstIssueField(error: z.ZodError): WalletField | undefined {
  const path = error.issues[0]?.path[0];
  return typeof path === "string" ? (path as WalletField) : undefined;
}

/**
 * Server Functions are reachable via direct POST requests, not just through
 * this app's forms (see node_modules/next/dist/docs/01-app/02-guides/
 * data-security.md and .../server-actions.md, "Authentication and
 * authorization"), so every action below re-derives the caller from the
 * session itself and re-validates `formData` with zod rather than trusting
 * either the render-time auth gate ((app)/layout.tsx) or the client.
 *
 * `owner_id` is never accepted from the client (walletInput has no such
 * field) — it always comes from `supabase.auth.getUser()` — and every
 * mutation additionally scopes its WHERE clause to that user's rows, in
 * front of (not instead of) the `wallets_write` RLS policy
 * (`owner_id = auth.uid()`, see supabase/migrations/0004_rls.sql). Errors
 * from Postgres are never forwarded to the client: this schema has no
 * user-actionable constraint on `wallets` beyond what zod already checks
 * (unlike e.g. categories' unique-name index), so a raw error string here
 * could only ever leak implementation detail, never useful guidance.
 */

/**
 * The shared body of `createWallet` and `addWallet`. Not exported (a
 * file-level `"use server"` makes every export a callable endpoint, and
 * this is not one) and returns a discriminated result rather than
 * redirecting, so each caller decides where the user goes next.
 *
 * This split exists because the two entry points need DIFFERENT
 * navigation: onboarding must leave /onboarding or the user is stranded on
 * a form they have already completed, while /wallets must stay put or
 * adding a second account throws the user back to the dashboard. Taking a
 * redirect target as a parameter was the obvious alternative and is worse:
 * a bound Server Function argument is serialized to the client and can be
 * tampered with, so it would put an open-redirect surface behind a
 * behaviour that is fully known at build time.
 */
async function insertWallet(formData: FormData): Promise<WalletState | { ok: true }> {
  const parsed = walletInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message, field: firstIssueField(parsed.error) };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { name, kind, currency_code, starting_balance, color_slot, icon } = parsed.data;

  // Money is bigint minor units end-to-end. parseAmountInput does pure
  // string->integer digit manipulation (never `parseFloat(x) * 100`, which
  // is banned project-wide) and is the only place in this action that
  // touches the amount, so this is correct for minor_unit 0 (JPY/KRW) and 3
  // (KWD) alike, not just the 2-decimal common case. walletInput's
  // superRefine already rejected a fraction longer than the currency
  // allows, so this call never silently truncates a user-entered value.
  //
  // parseAmountInput's regex also never accepts a leading "-" (the sign
  // comes from transaction kind in Task 18's keypad, not free text), so a
  // card wallet cannot be given a negative opening balance here — the form
  // states this limitation in its hint rather than silently flipping the
  // sign. Widening parseAmountInput itself is out of scope: it's shared
  // with Task 18, where a different caller supplies the sign.
  let startingMinor: number;
  try {
    startingMinor = parseAmountInput(starting_balance, minorUnitFor(currency_code));
  } catch {
    return { error: "Starting balance is not a valid amount", field: "starting_balance" };
  }

  // add_owner_as_member() (supabase/migrations/0002_wallets_categories.sql)
  // fires on this INSERT and creates the wallet_members(owner) row itself —
  // do not insert it here.
  const { error } = await supabase.from("wallets").insert({
    owner_id: user.id,
    name,
    kind,
    currency_code,
    starting_balance_minor: startingMinor,
    color_slot,
    icon,
  });
  if (error) return { error: "Could not create wallet. Please try again." };

  return { ok: true };
}

/**
 * Onboarding's entry point: creates the user's first wallet and leaves the
 * onboarding flow.
 */
export async function createWallet(
  _prev: WalletState,
  formData: FormData,
): Promise<WalletState> {
  const result = await insertWallet(formData);
  if (!("ok" in result)) return result;

  // "layout", not just "/": (app)/layout.tsx's wallet-count gate lives
  // above every route in that group, and this is what stops it from
  // bouncing the now-onboarded user straight back to /onboarding.
  revalidatePath("/", "layout");
  redirect("/");
}

/**
 * /wallets' entry point: same insert, but returns to the caller so the
 * management screen re-renders in place with the new wallet in its list.
 * `revalidatePath("/", "layout")` still runs — the layout's wallet-count
 * gate reads the same data, and a second wallet is also what unlocks
 * transfers in TransactionForm.
 */
export async function addWallet(
  _prev: WalletState,
  formData: FormData,
): Promise<WalletState> {
  const result = await insertWallet(formData);
  if (!("ok" in result)) return result;

  revalidatePath("/", "layout");
  revalidatePath("/wallets");
  return {};
}

/**
 * Edits an existing wallet's descriptive fields. Not consumed by
 * onboarding's UI (Task 15 covers wallet *creation* only, wallets is not in
 * the same route group as this file's other actions) — included because
 * the task's produced-interface list names it and the schema supports it;
 * a future wallet-management screen is expected to bind it the same way
 * src/server/actions/profile.ts's setTheme is bound today.
 *
 * `starting_balance_minor` and `currency_code` are deliberately NOT written
 * here, even though `walletInput` validates both (the schema is shared with
 * `createWallet`, which needs them):
 *
 *  - `starting_balance_minor` only means anything at creation time, seeding
 *    get_wallet_balances' running total. Changing it later would silently
 *    rewrite historical balances instead of recording a correction as its
 *    own event — a future "adjust balance" feature belongs in transactions,
 *    not a field edit.
 *  - `currency_code` has the identical problem, worse: a wallet holding
 *    `starting_balance_minor = 1000` under USD ($10.00) reinterpreted as
 *    JPY becomes ¥1,000 — a 100x value change with no data written, and
 *    `transactions` rows keep their own (now-mismatched) `currency_code`
 *    while get_wallet_balances sums both under one label. Changing a
 *    wallet's currency after it holds a balance or transactions is a
 *    migration operation (recompute/relabel every dependent row), not a
 *    field this action can safely touch.
 *
 * Both are reachable via direct POST regardless of what UI exists (see the
 * module doc comment above), so excluding them from the update payload,
 * not just from a form that doesn't render yet, is what actually closes
 * this off.
 */
export async function updateWallet(
  id: string,
  _prev: WalletState,
  formData: FormData,
): Promise<WalletState> {
  const parsed = walletInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message, field: firstIssueField(parsed.error) };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { name, kind, color_slot, icon } = parsed.data;

  const { error } = await supabase
    .from("wallets")
    .update({ name, kind, color_slot, icon })
    .eq("id", id)
    .eq("owner_id", user.id);
  if (error) return { error: "Could not update wallet. Please try again." };

  revalidatePath("/", "layout");
  revalidatePath("/wallets");
  return {};
}

/**
 * Soft-deletes a wallet. Scoped to the caller's own rows in the query
 * itself (`.eq("owner_id", user.id)`), not left to `wallets_write` RLS
 * alone, for the same defense-in-depth reason src/server/actions/
 * profile.ts's setTheme scopes its UPDATE despite `profiles_own` already
 * covering it.
 *
 * Returns `WalletState` rather than throwing (its original shape, which
 * had no consumer). Next replaces errors forwarded from the server with a
 * generic digest in production — see node_modules/next/dist/docs/01-app/
 * 03-api-reference/03-file-conventions/error.md: "Errors forwarded from
 * Server Components show a generic message with an identifier. This is to
 * prevent leaking sensitive details." The last-wallet refusal below is
 * guidance the user must actually be able to read, so it cannot travel as
 * a thrown message. This also matches every other action in this file and
 * in categories.ts/transactions.ts.
 *
 * Also revalidates the `(app)` layout: archiving a user's last wallet drops
 * their active-wallet count to zero, and that count is exactly what sends a
 * user to /onboarding, so a stale layout render would leave them stranded
 * on a shell with nothing to show instead of being routed back.
 */
export async function archiveWallet(id: string): Promise<WalletState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  // The app is unusable with zero active wallets — (app)/layout.tsx
  // redirects such a user straight to /onboarding — so archiving the last
  // one is refused rather than performed and then explained. WalletList
  // disables the button too; this is the enforcement, that is the
  // affordance. A Server Function is reachable by direct POST regardless
  // of what any UI renders (see this module's doc comment), so the UI
  // check alone would not actually hold the line.
  //
  // Counted, not derived from the client: the count must reflect the
  // database at the moment of the write, not what some page render
  // believed a while ago.
  const { count, error: countError } = await supabase
    .from("wallets")
    .select("id", { count: "exact", head: true })
    .is("archived_at", null)
    .eq("owner_id", user.id);
  // A count error is not "no wallets" — `count` is null for both, and
  // treating a transient failure as zero would flip this guard from
  // refusing to permitting, which is the wrong way for a guard to fail.
  if (countError) return { error: "Could not archive wallet. Please try again." };
  if ((count ?? 0) <= 1) {
    return { error: "You need at least one account. Add another before archiving this one." };
  }

  const { error } = await supabase
    .from("wallets")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_id", user.id);
  if (error) return { error: "Could not archive wallet. Please try again." };

  revalidatePath("/", "layout");
  revalidatePath("/wallets");
  return {};
}
