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
// "re-validate rather than trust the caller's static type" — an untyped-
// but-assumed-uuid `id` parameter is the one place that promise wasn't
// kept here.
const idSchema = z.uuid();

/**
 * Server Functions are reachable by direct POST, not only through this app's
 * forms, so each action below re-derives the caller from the session and
 * re-validates input with zod. Errors are RETURNED, never thrown: Next
 * replaces thrown server errors with an opaque digest in production, so a
 * thrown message never reaches the user.
 */

export async function setBudget(
  categoryKey: string | null,
  _prev: BudgetState,
  formData: FormData,
): Promise<BudgetState> {
  // `Object.fromEntries(formData)` would silently keep only the LAST
  // "walletIds" entry for a repeated form field — `getAll` is required to
  // see the whole set. This also means the empty-set refusal below runs
  // before any Supabase client is even constructed.
  const parsed = budgetInput.safeParse({
    amount: formData.get("amount"),
    walletIds: formData.getAll("walletIds"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  // Membership over the WHOLE submitted set, not just one wallet: members
  // are equal on money, matching what budgets_member permits. Checked here
  // so a non-member (of even one wallet in the set) gets a readable message
  // rather than a policy violation or set_budget's own internal text.
  // set_budget re-checks this too — this is belt-and-braces, the same
  // structure the previous single-wallet action used.
  const { data: memberships } = await supabase
    .from("wallet_members")
    .select("wallet_id")
    .eq("user_id", user.id)
    .in("wallet_id", parsed.data.walletIds);
  const memberWalletIds = new Set((memberships ?? []).map((m) => m.wallet_id));
  const isFullyMember = parsed.data.walletIds.every((id) => memberWalletIds.has(id));
  if (!isFullyMember) return { error: "You do not have access to one or more of those accounts." };

  // The budget is in the set's own currency, so its minor unit comes from
  // one of its wallets — never from the profile, and never from the
  // client. set_budget itself requires every wallet in the set to share a
  // currency, so any member of the set is representative; the first is as
  // good as any.
  const { data: wallet } = await supabase
    .from("wallets").select("currency_code").eq("id", parsed.data.walletIds[0]!).maybeSingle();
  if (!wallet) return { error: "Account not found." };

  let amountMinor: number;
  try {
    amountMinor = parseAmountInput(parsed.data.amount, minorUnitFor(wallet.currency_code));
  } catch {
    return { error: "That is not a valid amount." };
  }
  if (amountMinor <= 0) return { error: "Enter an amount greater than zero." };

  // Written through set_budget rather than a PostgREST upsert: `insert` is
  // revoked on both `budgets` and `budget_wallets` (0013) — set_budget,
  // SECURITY DEFINER, is the only path that can create or edit one, and it
  // re-checks everything above itself (membership, currency, archived
  // status, duplicate ids) before writing.
  //
  // set_budget's `p_category_key` is a plain (non-defaulted) `text` param,
  // which accepts NULL at the SQL level -- the overall-cap branch of the
  // function depends on that (an explicit NULL is a deliberate caller
  // choice; '' or whitespace is refused rather than silently normalised to
  // NULL, so a blank form field can never accidentally edit the household's
  // wallet-wide cap). Supabase's codegen has no way to see that from
  // information_schema (a parameter's own nullability isn't exposed the way
  // a column's is), so the generated Args type is the bare `string`, not
  // `string | null`.
  //
  // The relaxation is confined to that one field via `satisfies`, rather
  // than casting the whole args object to `string`: a bare
  // `p_category_key: categoryKey as string` would equally silence a future
  // type error if that expression became a number or undefined. Building
  // the object against `SetBudgetArgsRelaxed` means every OTHER field is
  // still checked against the real generated `Args` type, so a typo or a
  // signature change elsewhere in `set_budget` still fails typecheck here.
  //
  // `categoryKey` is passed through UNCHANGED — never `categoryKey ?? null`
  // or `categoryKey || null` — so an accidental empty string from a caller
  // reaches set_budget as `''`, which it refuses with its own message
  // (mapped to generic app copy below), rather than being silently
  // reinterpreted here as the overall cap.
  type SetBudgetArgs = Database["public"]["Functions"]["set_budget"]["Args"];
  type SetBudgetArgsRelaxed = Omit<SetBudgetArgs, "p_category_key"> & { p_category_key: string | null };

  const args = {
    p_category_key: categoryKey,
    p_period_start: monthRange().from,
    p_amount_minor: amountMinor,
    // A flat array of strings, exactly as `formData.getAll` produced it via
    // `budgetInput`. Never wrap or nest this: a nested array
    // (`{{w1,w2}}`) once defeated set_budget's membership guard because
    // `array_length(x, 1)` counts only the first dimension while `unnest`
    // counts every element — fixed at the SQL layer (0013's C1 finding),
    // but there is no reason to hand it a shape that relies on that fix.
    p_wallet_ids: parsed.data.walletIds,
  } satisfies SetBudgetArgsRelaxed;

  const { error } = await supabase.rpc("set_budget", args as SetBudgetArgs);
  // set_budget raises readable internal messages (e.g. "not a member of
  // every account in that set", "every account in a budget must use the
  // same currency") — never forwarded verbatim, since they are meant for
  // this file's own reviewers, not end users.
  if (error) return { error: "Could not save that budget. Please try again." };

  revalidatePath("/budgets");
  // The dashboard also shows budgets (a later task), so a stale dashboard
  // beside a fresh budgets screen would be worse than either being stale
  // alone.
  revalidatePath("/");
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
  // The dashboard also shows budgets (a later task) — same reasoning as
  // setBudget's revalidation above.
  revalidatePath("/");
  return {};
}
