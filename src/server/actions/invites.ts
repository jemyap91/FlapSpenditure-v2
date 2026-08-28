"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { inviteInput } from "@/lib/validation/invite";

export type InviteState = { error?: string; notice?: string };

/**
 * Server Functions are reachable by direct POST, so each action below
 * re-derives the caller and re-checks authority rather than trusting the UI
 * that rendered the control. Errors are RETURNED, never thrown: Next replaces
 * thrown server errors with an opaque digest in production.
 */

export async function inviteToWallet(
  walletId: string,
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const parsed = inviteInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  if (parsed.data.email === (user.email ?? "").toLowerCase()) {
    return { error: "You are already in this wallet." };
  }

  const { error } = await supabase.from("wallet_invites").insert({
    wallet_id: walletId,
    invited_email: parsed.data.email,
    invited_by: user.id,
  });
  if (error) {
    // A duplicate gets its own message. "Please try again" was actively
    // misleading here — retrying is the one action guaranteed to fail for as
    // long as the pending invite exists, and this was hit in production.
    //
    // Naming this case does NOT reopen the enumeration oracle the generic
    // message exists to close: 23505 on `wallet_invites_one_pending` reports
    // only that THIS owner already invited THIS address to THEIR OWN wallet
    // — something they are already entitled to know, and which says nothing
    // about whether that address has an account. Compare `invites_owner_insert`
    // refusing a non-owner, which must stay generic.
    if (error.code === "23505") {
      return { error: "There is already a pending invitation to that address for this wallet." };
    }
    return { error: "Could not send that invitation. Please try again." };
  }

  revalidatePath("/wallets");
  // Deliberately identical whether or not that address has an account: this
  // form must not become a way to test who is registered, the same reasoning
  // src/lib/validation/auth.ts applies to signup.
  return { notice: `Invitation sent to ${parsed.data.email}.` };
}

export async function respondToInvite(id: string, accept: boolean): Promise<InviteState> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { error } = await supabase.rpc(
    accept ? "accept_wallet_invite" : "decline_wallet_invite",
    { invite: id },
  );
  if (error) return { error: "Could not respond to that invitation." };

  revalidatePath("/", "layout");
  revalidatePath("/wallets");
  return {};
}

export async function removeMember(walletId: string, userId: string): Promise<InviteState> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  // The owner's own membership row is what makes them a member; removing it
  // would lock them out of a wallet they still own.
  const { data: wallet } = await supabase
    .from("wallets").select("owner_id").eq("id", walletId).maybeSingle();
  if (!wallet || wallet.owner_id !== user.id) return { error: "Only the wallet owner can do that." };
  // Postgres returns owner_id already lower-cased, but userId arrives from
  // the client and is never normalised on the way in — a bare `===` here
  // would let an uppercased copy of the owner's own id slip past this
  // check (`AAAA... !== aaaa...` in JS) while Postgres's `uuid` type
  // equality is case-INSENSITIVE, so the DELETE below would still match
  // and remove the owner's row anyway. Normalise both sides before
  // comparing, the same way every other id comparison in this codebase
  // pushes case handling to a place that can't get it wrong (see
  // src/server/actions/wallets.ts's .eq("owner_id", ...) filters, which
  // let Postgres — not JS — decide equality).
  if (userId.trim().toLowerCase() === wallet.owner_id.toLowerCase()) {
    return { error: "The owner cannot be removed." };
  }

  const { error } = await supabase
    .from("wallet_members")
    .delete()
    .eq("wallet_id", walletId)
    .eq("user_id", userId)
    // Defence in depth: even if the JS guard above were ever wrong, this
    // is type-correct by construction — Postgres compares as `uuid`, not
    // as a string, so it cannot be bypassed by case the way `===` above
    // could.
    .neq("user_id", wallet.owner_id);
  if (error) return { error: "Could not remove that person. Please try again." };

  // Access is changing for the removed person, and the (app) layout's
  // wallet-count/membership gate reads the same membership data —
  // the same reasoning respondToInvite's revalidation follows above.
  revalidatePath("/", "layout");
  revalidatePath("/wallets");
  return {};
}

/**
 * Withdraws an invitation the owner sent but the recipient has not answered.
 *
 * Needed because `wallet_invites_one_pending` refuses a second pending
 * invite to the same address, so a mistyped address was previously
 * unrecoverable from the UI — the owner saw only "there is already a
 * pending invitation" with no way to clear it short of editing the database.
 *
 * A DELETE rather than a status change: `wallet_invites` grants
 * `authenticated` no UPDATE at all, deliberately, so that `status` can only
 * move through the two SECURITY DEFINER functions (0009). Deleting also
 * frees the partial unique index immediately, which is the point.
 *
 * Ownership is re-checked here, ahead of `invites_owner_delete`, so a
 * non-owner gets a readable message instead of a silent zero-row delete —
 * the same failure mode `archiveWallet` guards against.
 */
export async function revokeInvite(walletId: string, inviteId: string): Promise<InviteState> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { data, error } = await supabase
    .from("wallet_invites")
    .delete()
    .eq("id", inviteId)
    .eq("wallet_id", walletId)
    .eq("status", "pending")
    .select("id");

  if (error) return { error: "Could not withdraw that invitation. Please try again." };
  // RLS turns "not yours" into zero rows rather than an error, so an
  // unchecked delete would report success having done nothing.
  if (!data || data.length === 0) return { error: "That invitation is no longer pending." };

  revalidatePath("/wallets");
  return {};
}