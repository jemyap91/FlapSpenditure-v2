"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { walletInput } from "@/lib/validation/wallet";
import { parseAmountInput, minorUnitFor } from "@/lib/money";

export type WalletState = { error?: string };

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

export async function createWallet(
  _prev: WalletState,
  formData: FormData,
): Promise<WalletState> {
  const parsed = walletInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

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
  // (KWD) alike, not just the 2-decimal common case.
  let startingMinor: number;
  try {
    startingMinor = parseAmountInput(starting_balance, minorUnitFor(currency_code));
  } catch {
    return { error: "Starting balance is not a valid amount" };
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

  // "layout", not just "/": (app)/layout.tsx's wallet-count gate lives
  // above every route in that group, and this is what stops it from
  // bouncing the now-onboarded user straight back to /onboarding.
  revalidatePath("/", "layout");
  redirect("/");
}

/**
 * Edits an existing wallet's descriptive fields. Not consumed by
 * onboarding's UI (Task 15 covers wallet *creation* only, wallets is not in
 * the same route group as this file's other actions) — included because
 * the task's produced-interface list names it and the schema supports it;
 * a future wallet-management screen is expected to bind it the same way
 * src/server/actions/profile.ts's setTheme is bound today.
 *
 * `starting_balance_minor` is deliberately NOT editable here: it only means
 * anything at creation time, seeding get_wallet_balances' running total.
 * Changing it later would silently rewrite historical balances instead of
 * recording a correction as its own event — a future "adjust balance"
 * feature belongs in transactions, not a field edit.
 */
export async function updateWallet(
  id: string,
  _prev: WalletState,
  formData: FormData,
): Promise<WalletState> {
  const parsed = walletInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { name, kind, currency_code, color_slot, icon } = parsed.data;

  const { error } = await supabase
    .from("wallets")
    .update({ name, kind, currency_code, color_slot, icon })
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
 * Also revalidates the `(app)` layout: archiving a user's last wallet drops
 * their active-wallet count to zero, and that count is exactly what sends a
 * user to /onboarding, so a stale layout render would leave them stranded
 * on a shell with nothing to show instead of being routed back.
 */
export async function archiveWallet(id: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { error } = await supabase
    .from("wallets")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_id", user.id);
  if (error) throw new Error("Could not archive wallet");

  revalidatePath("/", "layout");
  revalidatePath("/wallets");
}
