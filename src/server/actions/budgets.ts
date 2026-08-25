"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { budgetInput } from "@/lib/validation/budget";
import { parseAmountInput, minorUnitFor } from "@/lib/money";
import { monthRange } from "@/lib/month-range";
import type { Database } from "@/lib/database.types";

export type BudgetState = { error?: string; notice?: string };

// Not exported — same reasoning as src/server/actions/categories.ts's own
// `idSchema` (~:9-18): a Server Function is reachable via direct POST with
// any string, not just a real uuid a `<button onClick>` would ever
// produce, and this file's own doc comment already commits to
// "re-validate rather than trust the caller's static type" — untyped-but-
// assumed-uuid `walletId`/`categoryId`/`id` parameters were the one place
// that promise wasn't kept here. `categoryId` is additionally nullable:
// null is the legitimate "overall cap" value (see setBudget below), not a
// missing/invalid one.
const idSchema = z.uuid();
const nullableIdSchema = z.uuid().nullable();

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

  // Same "not distinguishable from a real id you don't have access to"
  // reasoning as categories.ts's archiveCategory: a malformed walletId
  // gets the exact message a real-but-inaccessible one gets below, not a
  // separate "invalid id" — there's no reason to give an adversarial
  // caller a way to tell those apart, and it means this check can run
  // before any query touches the database.
  if (!idSchema.safeParse(walletId).success) {
    return { error: "You do not have access to that account." };
  }
  // A malformed (non-uuid, non-null) categoryId can never resolve to a
  // real category, so it can never produce anything but a failed write —
  // reusing that write-failure message rather than inventing a new one.
  if (!nullableIdSchema.safeParse(categoryId).success) {
    return { error: "Could not save that budget. Please try again." };
  }

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
  //
  // set_budget's `p_category_id` is a plain (non-defaulted) `uuid` param,
  // which accepts NULL at the SQL level -- the overall-cap branch of the
  // function depends on that. Supabase's codegen has no way to see that
  // from information_schema (a parameter's own nullability isn't exposed
  // the way a column's is), so the generated Args type is the bare
  // `string`, not `string | null`. Unlike `create_transfer`'s `note`
  // (src/server/actions/transactions.ts) -- an OPTIONAL, defaulted param
  // where omitting the key is equivalent to null -- this one is required
  // with no default, so it cannot be left out; the value itself must be
  // null.
  //
  // The relaxation is confined to that one field via `satisfies`, rather
  // than casting the whole args object (or just `categoryId`) to `string`:
  // a bare `p_category_id: categoryId as string` would equally silence a
  // future type error if that expression became a number or undefined.
  // Building the object against `SetBudgetArgsRelaxed` means every OTHER
  // field is still checked against the real generated `Args` type, so a
  // typo or a signature change elsewhere in `set_budget` still fails
  // typecheck here.
  type SetBudgetArgs = Database["public"]["Functions"]["set_budget"]["Args"];
  type SetBudgetArgsRelaxed = Omit<SetBudgetArgs, "p_category_id"> & { p_category_id: string | null };

  const args = {
    p_wallet_id: walletId,
    p_category_id: categoryId,
    p_period_start: monthRange().from,
    p_amount_minor: amountMinor,
  } satisfies SetBudgetArgsRelaxed;

  const { error } = await supabase.rpc("set_budget", args as SetBudgetArgs);
  if (error) return { error: "Could not save that budget. Please try again." };

  revalidatePath("/budgets");
  // A `notice`, not `{}`: the always-mounted `role="status"` paragraph
  // BudgetList.tsx renders this state through is otherwise silent on
  // success — the amount just changes on screen, with nothing said aloud.
  // Matches inviteToWallet's identical shape (src/server/actions/invites.ts).
  return { notice: "Budget saved." };
}

export async function removeBudget(id: string): Promise<BudgetState> {
  // Deliberately the same "no longer exists" message a real-but-nonexistent
  // id gets below (categories.ts's archiveCategory, same reasoning): a
  // malformed id and one that simply doesn't belong to this caller are
  // indistinguishable from the outside, so both get the same answer.
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return { error: "That budget no longer exists." };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { data, error } = await supabase
    .from("budgets").delete().eq("id", parsedId.data).select("id");

  if (error) return { error: "Could not remove that budget. Please try again." };
  // RLS turns "not yours" into zero rows rather than an error, so an
  // unchecked delete would report success having done nothing — the silent
  // false success archiveWallet and revokeInvite were both fixed for.
  if (!data || data.length === 0) return { error: "That budget no longer exists." };

  revalidatePath("/budgets");
  return {};
}
