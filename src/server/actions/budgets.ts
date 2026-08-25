"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { budgetInput } from "@/lib/validation/budget";
import { parseAmountInput, minorUnitFor } from "@/lib/money";
import { monthRange } from "@/lib/month-range";

export type BudgetState = { error?: string; notice?: string };

/**
 * Server Functions are reachable by direct POST, not only through this app's
 * forms, so each action below re-derives the caller from the session and
 * re-validates input with zod. Errors are RETURNED, never thrown: Next
 * replaces thrown server errors with an opaque digest in production, so a
 * thrown message never reaches the user.
 */

export async function setBudget(
  walletId: string,
  categoryId: string | null,
  _prev: BudgetState,
  formData: FormData,
): Promise<BudgetState> {
  const parsed = budgetInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  // Membership, not ownership: members are equal on money, matching what
  // budgets_member permits. Checked here so a non-member gets a readable
  // message rather than a policy violation. set_budget re-checks it too.
  const { data: membership } = await supabase
    .from("wallet_members")
    .select("wallet_id")
    .eq("wallet_id", walletId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) return { error: "You do not have access to that account." };

  // The budget is in the wallet's own currency, so its minor unit comes from
  // the wallet — not from the profile, and never from the client.
  const { data: wallet } = await supabase
    .from("wallets").select("currency_code").eq("id", walletId).maybeSingle();
  if (!wallet) return { error: "Account not found." };

  let amountMinor: number;
  try {
    amountMinor = parseAmountInput(parsed.data.amount, minorUnitFor(wallet.currency_code));
  } catch {
    return { error: "That is not a valid amount." };
  }
  if (amountMinor <= 0) return { error: "Enter an amount greater than zero." };

  // Written through set_budget rather than a PostgREST upsert: uniqueness here
  // rests on PARTIAL indexes, which ON CONFLICT can only infer when the
  // statement repeats the index predicate — something `onConflict` cannot
  // express. See the function's own comment in 0012.
  const { error } = await supabase.rpc("set_budget", {
    p_wallet_id: walletId,
    // set_budget's `p_category_id` is a plain (non-defaulted) `uuid` param,
    // which accepts NULL at the SQL level -- the overall-cap branch of the
    // function depends on that. Supabase's codegen has no way to see that
    // from information_schema (a parameter's own nullability isn't
    // exposed the way a column's is), so the generated Args type is the
    // bare `string`, not `string | null`. Unlike `create_transfer`'s
    // `note` (src/server/actions/transactions.ts) -- an OPTIONAL,
    // defaulted param where omitting the key is equivalent to null -- this
    // one is required with no default, so it cannot be left out; the value
    // itself must be null, hence the cast rather than `?? undefined`.
    p_category_id: categoryId as string,
    p_period_start: monthRange().from,
    p_amount_minor: amountMinor,
  });
  if (error) return { error: "Could not save that budget. Please try again." };

  revalidatePath("/budgets");
  return {};
}

export async function removeBudget(id: string): Promise<BudgetState> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { data, error } = await supabase
    .from("budgets").delete().eq("id", id).select("id");

  if (error) return { error: "Could not remove that budget. Please try again." };
  // RLS turns "not yours" into zero rows rather than an error, so an
  // unchecked delete would report success having done nothing — the silent
  // false success archiveWallet and revokeInvite were both fixed for.
  if (!data || data.length === 0) return { error: "That budget no longer exists." };

  revalidatePath("/budgets");
  return {};
}
