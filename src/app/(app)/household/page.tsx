import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserProfile } from "@/lib/supabase/current-user";
import { HouseholdSection, type HouseholdInvite, type HouseholdMember, type HouseholdWallet } from "./HouseholdSection";

type Member = HouseholdMember & { space_id: string };
type Wallet = HouseholdWallet & { space_id: string };
type Access = { wallet_id: string; user_id: string; via: "owner" | "household" | "direct" };
type Invite = HouseholdInvite & { space_id: string };

/**
 * /household — manage every household you belong to: who's in it, pending
 * invitations, and which wallets each member can see. Membership itself is
 * still derived (every account gets a household at signup, and accepting a
 * wallet invite joins you to that wallet's household), but this screen is
 * no longer read-only: the household OWNER can invite, revoke, and remove;
 * anyone can leave; and each wallet's OWNER decides that wallet's sharing.
 *
 * Five RLS-scoped reads, no explicit membership filter — the same trust
 * boundary every other Server Component in this app sits behind:
 * - `spaces` under spaces_member (`is_space_member(id)`).
 * - `get_space_members()`, SECURITY DEFINER for the same reason
 *   /wallets uses get_wallet_members: profiles_own hides co-members' names.
 * - `wallets` under wallets_select, so the wallet list is "the wallets in
 *   this household that YOU are in" — a co-member's private wallet is in the
 *   same household but is not yours to see, and is not listed.
 * - `get_wallet_sharing()`, SECURITY DEFINER, for the (wallet, user) -> via
 *   grid `HouseholdSection` renders.
 * - `space_invites` under its own RLS (readable by the household owner and
 *   the invitee), filtered here to `status = 'pending'`.
 *
 * Almost everyone belongs to exactly one household (a second arrives only
 * via an invite from outside your own), so the single-household case is the
 * design: the heading is "Household", the name is a subtitle, and only a
 * user in two or more gets one section per household.
 */
export default async function HouseholdPage() {
  const supabase = await createClient();
  const profile = await getCurrentUserProfile();
  if (!profile) throw new Error("Not signed in");

  const [
    { data: spaces, error: spacesError },
    { data: members, error: membersError },
    { data: wallets, error: walletsError },
    { data: access, error: accessError },
    { data: invites, error: invitesError },
  ] = await Promise.all([
    supabase.from("spaces").select("id, name").order("created_at"),
    supabase.rpc("get_space_members"),
    supabase
      .from("wallets")
      .select("id, name, owner_id, shared_with_household, archived_at, space_id")
      .order("created_at"),
    supabase.rpc("get_wallet_sharing"),
    supabase.from("space_invites").select("id, space_id, invited_email").eq("status", "pending"),
  ]);

  // A query error is not "no household" — thrown, matching every other
  // Server Component in this app, so a transient failure never renders as
  // an empty screen.
  if (spacesError) throw new Error("Failed to load households");
  if (membersError) throw new Error("Failed to load household members");
  if (walletsError) throw new Error("Failed to load wallets");
  if (accessError) throw new Error("Failed to load sharing");
  if (invitesError) throw new Error("Failed to load invitations");
  if (!spaces?.length) redirect("/onboarding");

  const membersBySpace = new Map<string, Member[]>();
  for (const m of (members ?? []) as Member[]) {
    const list = membersBySpace.get(m.space_id) ?? [];
    list.push(m);
    membersBySpace.set(m.space_id, list);
  }
  const walletsBySpace = new Map<string, Wallet[]>();
  for (const w of (wallets ?? []) as Wallet[]) {
    const list = walletsBySpace.get(w.space_id) ?? [];
    list.push(w);
    walletsBySpace.set(w.space_id, list);
  }
  const invitesBySpace = new Map<string, Invite[]>();
  for (const inv of (invites ?? []) as Invite[]) {
    const list = invitesBySpace.get(inv.space_id) ?? [];
    list.push(inv);
    invitesBySpace.set(inv.space_id, list);
  }

  const single = spaces.length === 1;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-1 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        {single ? "Household" : "Households"}
      </h1>
      <p className="mb-6 text-sm" style={{ color: "var(--ink-2)" }}>
        Everyone in a household shares one list of categories. The household owner invites people
        here; each wallet&apos;s owner chooses who sees it.
      </p>

      <div className="flex flex-col gap-8">
        {spaces.map((space) => {
          const spaceWallets = walletsBySpace.get(space.id) ?? [];
          const walletIds = new Set(spaceWallets.map((w) => w.id));
          const spaceAccess = ((access ?? []) as Access[]).filter((a) => walletIds.has(a.wallet_id));
          return (
            <HouseholdSection
              key={space.id}
              space={space}
              currentUserId={profile.id}
              members={membersBySpace.get(space.id) ?? []}
              wallets={spaceWallets}
              access={spaceAccess}
              pendingInvites={invitesBySpace.get(space.id) ?? []}
              single={single}
            />
          );
        })}
      </div>
    </div>
  );
}
