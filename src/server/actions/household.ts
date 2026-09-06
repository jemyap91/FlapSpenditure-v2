"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { inviteInput } from "@/lib/validation/invite";

export type HouseholdState = { error?: string; notice?: string };

/**
 * Household actions. Every write here is a SECURITY DEFINER RPC (0025)
 * whose own guards are the whole security boundary -- these functions
 * re-validate shape before the round trip and translate refusals into
 * app-authored copy, never forwarding the database's own message.
 */
const idSchema = z.uuid();
const idsSchema = z.array(z.uuid());

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export async function setWalletSharing(
  walletId: string,
  householdShared: boolean,
  directUserIds: string[],
): Promise<HouseholdState> {
  const wallet = idSchema.safeParse(walletId);
  if (!wallet.success) return { error: "That wallet no longer exists." };
  const direct = idsSchema.safeParse(directUserIds);
  if (!direct.success) return { error: "That person is not valid." };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { error } = await supabase.rpc("set_wallet_sharing", {
    p_wallet: wallet.data,
    p_household: householdShared,
    p_direct: direct.data,
  });
  if (error) {
    if (error.message === "a wallet can only be shared with people in its household") {
      return { error: "You can only share a wallet with people in its household." };
    }
    return { error: "Could not update sharing. Please try again." };
  }
  revalidatePath("/wallets");
  revalidatePath("/household");
  return { notice: "Sharing updated." };
}

export async function inviteToHousehold(
  spaceId: string,
  _prev: HouseholdState,
  formData: FormData,
): Promise<HouseholdState> {
  const space = idSchema.safeParse(spaceId);
  if (!space.success) return { error: "That household no longer exists." };
  const parsed = inviteInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };
  if (parsed.data.email === (user.email ?? "").toLowerCase()) {
    return { error: "You are already in this household." };
  }

  const { error } = await supabase.rpc("invite_to_space", { p_space: space.data, p_email: parsed.data.email });
  if (error) {
    if (error.code === "23505") return { error: "There is already a pending invitation to that address." };
    if (error.message === "that person is already in this household") {
      return { error: "That person is already in this household." };
    }
    return { error: "Could not send that invitation. Please try again." };
  }
  revalidatePath("/household");
  return { notice: `Invitation sent to ${parsed.data.email}.` };
}

export async function revokeHouseholdInvite(inviteId: string): Promise<HouseholdState> {
  const id = idSchema.safeParse(inviteId);
  if (!id.success) return { error: "That invitation is no longer pending." };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };
  const { error } = await supabase.rpc("revoke_space_invite", { p_invite: id.data });
  if (error) return { error: "Could not withdraw that invitation. Please try again." };
  revalidatePath("/household");
  return {};
}

export async function respondToHouseholdInvite(inviteId: string, accept: boolean): Promise<HouseholdState> {
  const id = idSchema.safeParse(inviteId);
  if (!id.success) return { error: "That invitation is no longer pending." };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };
  const { error } = await supabase.rpc(accept ? "accept_space_invite" : "decline_space_invite", {
    p_invite: id.data,
  });
  if (error) return { error: "Could not respond to that invitation." };
  revalidatePath("/", "layout");
  revalidatePath("/wallets");
  revalidatePath("/household");
  return {};
}

type LeaveSummary = { wallets_moved: number; budgets_moved: number; budgets_trimmed: number };

function summarise(rows: LeaveSummary[] | null, who: "you" | "them"): string {
  const s = rows?.[0] ?? { wallets_moved: 0, budgets_moved: 0, budgets_trimmed: 0 };
  return `${plural(s.wallets_moved, "wallet", "wallets")} and ${plural(s.budgets_moved, "budget", "budgets")} went with ${who}; ${plural(s.budgets_trimmed, "budget", "budgets")} lost a wallet.`;
}

export async function leaveHousehold(spaceId: string): Promise<HouseholdState> {
  const space = idSchema.safeParse(spaceId);
  if (!space.success) return { error: "That household no longer exists." };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };
  const { data, error } = await supabase.rpc("leave_space", { p_space: space.data });
  if (error) {
    if (error.message === "the household owner cannot leave") return { error: "The household owner cannot leave." };
    return { error: "Could not leave the household. Please try again." };
  }
  revalidatePath("/", "layout");
  return { notice: `You left the household. ${summarise(data as LeaveSummary[] | null, "you")}` };
}

export async function removeHouseholdMember(spaceId: string, userId: string): Promise<HouseholdState> {
  const space = idSchema.safeParse(spaceId);
  if (!space.success) return { error: "That household no longer exists." };
  const target = idSchema.safeParse(userId);
  if (!target.success) return { error: "That person is not in this household." };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };
  const { data, error } = await supabase.rpc("remove_space_member", { p_space: space.data, p_user: target.data });
  if (error) return { error: "Could not remove that person. Please try again." };
  revalidatePath("/", "layout");
  return { notice: `Removed from the household. ${summarise(data as LeaveSummary[] | null, "them")}` };
}
