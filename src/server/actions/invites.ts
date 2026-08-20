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
    return { error: "You are already in this account." };
  }

  const { error } = await supabase.from("wallet_invites").insert({
    wallet_id: walletId,
    invited_email: parsed.data.email,
    invited_by: user.id,
  });
  // invites_owner rejects a non-owner, and wallet_invites_one_pending rejects
  // a duplicate. Neither raw message is forwarded — see the module comment.
  if (error) return { error: "Could not send that invitation. Please try again." };

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
  if (!wallet || wallet.owner_id !== user.id) return { error: "Only the account owner can do that." };
  if (userId === wallet.owner_id) return { error: "The owner cannot be removed." };

  const { error } = await supabase
    .from("wallet_members").delete().eq("wallet_id", walletId).eq("user_id", userId);
  if (error) return { error: "Could not remove that person. Please try again." };

  revalidatePath("/wallets");
  return {};
}
