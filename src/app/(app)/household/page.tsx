import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserProfile } from "@/lib/supabase/current-user";

type Member = { space_id: string; user_id: string; display_name: string; role: "owner" | "member" };
type Wallet = { id: string; name: string; currency_code: string; archived_at: string | null; space_id: string };

/**
 * /household — who shares a category list with you, and which wallets sit
 * in it. Read-only by design (spec 2026-09-05 §10): membership is DERIVED,
 * never chosen here. Every account gets a household at signup
 * (handle_new_user, 0022), and accepting a wallet invite joins you to that
 * wallet's household (wallet_members_set_space, 0022) because reading the
 * wallet's transactions requires reading the categories they point at.
 * There is therefore nothing to add or remove on this screen; the invite
 * flow on /wallets is the way in, and this page says so.
 *
 * Three RLS-scoped reads, no explicit membership filter — the same trust
 * boundary every other Server Component in this app sits behind:
 * - `spaces` under spaces_member (`is_space_member(id)`).
 * - `get_space_members()` (0024), SECURITY DEFINER for the same reason
 *   /wallets uses get_wallet_members: profiles_own hides co-members' names.
 * - `wallets` under wallets_select, so the wallet list is "the wallets in
 *   this household that YOU are in" — a co-member's private wallet is in the
 *   same household but is not yours to see, and is not listed.
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
  ] = await Promise.all([
    supabase.from("spaces").select("id, name").order("created_at"),
    supabase.rpc("get_space_members"),
    supabase
      .from("wallets")
      .select("id, name, currency_code, archived_at, space_id")
      .order("created_at"),
  ]);

  // A query error is not "no household" — thrown, matching every other
  // Server Component in this app, so a transient failure never renders as
  // an empty screen.
  if (spacesError) throw new Error("Failed to load households");
  if (membersError) throw new Error("Failed to load household members");
  if (walletsError) throw new Error("Failed to load wallets");
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

  const single = spaces.length === 1;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-1 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        {single ? "Household" : "Households"}
      </h1>
      <p className="mb-6 text-sm" style={{ color: "var(--ink-2)" }}>
        Everyone in a household shares one list of categories. To bring someone in, invite them to one
        of your wallets from the Wallets screen — accepting the invite joins them here.
      </p>

      <div className="flex flex-col gap-8">
        {spaces.map((space) => {
          const spaceMembers = (membersBySpace.get(space.id) ?? [])
            .slice()
            // Owners first, then by name, so the list reads the same way
            // every visit rather than in heap order.
            .sort((a, b) =>
              a.role === b.role ? a.display_name.localeCompare(b.display_name) : a.role === "owner" ? -1 : 1,
            );
          const spaceWallets = walletsBySpace.get(space.id) ?? [];
          return (
            <section key={space.id} aria-labelledby={`household-${space.id}`}>
              <h2
                id={`household-${space.id}`}
                className={single ? "mb-4 text-lg font-semibold" : "mb-4 text-xl font-semibold"}
                style={{ color: "var(--ink)" }}
              >
                {space.name}
              </h2>

              <h3
                className="mb-2 text-sm font-medium uppercase tracking-wide"
                style={{ color: "var(--ink-2)" }}
              >
                Members
              </h3>
              <ul className="mb-6 flex flex-col gap-2" aria-label={`${space.name} members`}>
                {spaceMembers.map((m) => (
                  <li
                    key={m.user_id}
                    className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                    style={{ borderColor: "var(--grid)", background: "var(--surface)", color: "var(--ink)" }}
                  >
                    <span>
                      {m.display_name}
                      {m.user_id === profile.id && (
                        <span className="ml-2 text-xs" style={{ color: "var(--ink-2)" }}>
                          (you)
                        </span>
                      )}
                    </span>
                    <span className="text-xs" style={{ color: "var(--ink-2)" }}>
                      {m.role === "owner" ? "Owner" : "Member"}
                    </span>
                  </li>
                ))}
              </ul>

              <h3
                className="mb-2 text-sm font-medium uppercase tracking-wide"
                style={{ color: "var(--ink-2)" }}
              >
                Wallets you are in
              </h3>
              {spaceWallets.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--ink-2)" }}>
                  No wallets yet.
                </p>
              ) : (
                <ul className="flex flex-col gap-2" aria-label={`${space.name} wallets`}>
                  {spaceWallets.map((w) => (
                    <li
                      key={w.id}
                      className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                      style={{ borderColor: "var(--grid)", background: "var(--surface)", color: "var(--ink)" }}
                    >
                      <span>{w.name}</span>
                      <span className="text-xs" style={{ color: "var(--ink-2)" }}>
                        {w.currency_code}
                        {w.archived_at !== null && " · Archived"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
