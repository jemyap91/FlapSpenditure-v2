import { createClient } from "@/lib/supabase/server";
import { getCurrentUserProfile } from "@/lib/supabase/current-user";
import { addWallet, updateWallet } from "@/server/actions/wallets";
import { WalletForm } from "@/components/WalletForm";
import { WalletList } from "./WalletList";
import { MembersSection, type Member, type PendingInvite as SectionInvite } from "./MembersSection";
import { PendingInvites, type PendingInvite } from "./PendingInvites";
import { walletSortInput } from "@/lib/validation/wallet-group";
import { mergeWalletBalances, arrangeWallets, defaultCurrencyFor, type BalanceRow, type WalletRow } from "./wallet-rows";

/**
 * /wallets — the wallets screen. Both the Sidebar and the TabBar have
 * linked here since Task 14; until now the route did not exist and the nav
 * item 404'd.
 *
 * It is also the only screen that can create a SECOND wallet: /onboarding
 * creates the first and then refuses to render again (it redirects to /
 * once an active wallet exists), so before this page there was no way to
 * reach two wallets at all — and TransactionForm gates transfers on
 * `wallets.length >= 2`. Adding a wallet here is what unlocks them.
 *
 * `wallets_select` RLS (`is_wallet_member`) already scopes this SELECT to
 * the caller's own wallets, so no explicit `.eq("owner_id", ...)` is needed
 * for a read — the same convention src/app/(app)/categories/page.tsx
 * follows, and unlike the mutations in server/actions/wallets.ts, which
 * scope defensively anyway.
 *
 * The two reads are issued together but are not one transaction, which is
 * exactly why `mergeWalletBalances` treats a missing balance row as
 * "unknown" rather than zero — see its own doc comment.
 *
 * Two more reads back Task 8's members/invites UI, both via SECURITY
 * DEFINER RPCs added in 0010 rather than plain selects — plain RLS-scoped
 * selects cannot supply this data at all:
 *
 * - `get_wallet_members()` — `wallet_members` is visible to co-members
 *   (`members_select`), but `profiles` is not (`profiles_own` is
 *   `id = auth.uid()`, full stop), so a plain `wallet_members -> profiles`
 *   embed would return every co-member's `display_name` as null.
 * - `get_pending_invites()` — `invites_invitee_select` lets the invitee
 *   read their own `wallet_invites` row, but they are by definition not
 *   yet a member of that wallet, so `wallets_select` (`is_wallet_member`)
 *   would hide the join target and the invite's wallet NAME along with it.
 *
 * Both RPCs self-scope to the caller (membership / invited-email match) —
 * see 0010's own doc comment — so, like the two reads above, no explicit
 * `.eq(...)` filter is added here either.
 */
export default async function WalletsPage() {
  const supabase = await createClient();
  const profile = await getCurrentUserProfile();
  // (app)/layout.tsx already redirects to /login when there is no session,
  // before this page ever renders — this is defence in depth, not a real
  // path: `ownerId` below would be meaningless (every wallet would read as
  // "not mine") for a request that somehow reached here unauthenticated.
  if (!profile) throw new Error("Not signed in");

  const [
    { data: wallets, error: walletsError },
    { data: balances, error: balancesError },
    { data: members, error: membersError },
    { data: invites, error: invitesError },
    { data: sentInvites, error: sentInvitesError },
    { data: groups, error: groupsError },
    { data: prefs, error: prefsError },
  ] = await Promise.all([
    supabase
      .from("wallets")
      .select("id, name, kind, currency_code, color_slot, icon, owner_id, starting_balance_minor, created_at")
      .is("archived_at", null)
      .order("created_at"),
    supabase.rpc("get_wallet_balances"),
    supabase.rpc("get_wallet_members"),
    supabase.rpc("get_pending_invites"),
    // Invitations this person has SENT. Distinct from get_pending_invites(),
    // which returns invites addressed TO them. `invites_owner_select` scopes
    // this to wallets they own, so no extra filter is needed — but note
    // `invites_invitee_select` also grants read on invites addressed to
    // them, hence the explicit ownership narrowing below.
    supabase
      .from("wallet_invites")
      .select("id, wallet_id, invited_email")
      .eq("status", "pending"),
    // This viewer's own grouping and ordering (0019_wallet_groups.sql).
    // Both tables are scoped to `user_id = auth.uid()` by RLS, so neither
    // needs an explicit filter — and neither can see another member's
    // arrangement of the same wallets, which is the point of them existing.
    supabase.from("wallet_groups").select("id, name, sort_order").order("sort_order"),
    supabase.from("wallet_prefs").select("wallet_id, group_id, sort_order"),
  ]);

  // A query error is not an empty result — `data` comes back null for all
  // four, so skipping this check would render "No wallets yet" (and,
  // worse, the last-wallet guard's own disabled state) on a transient DB
  // blip. Thrown, not redirected, matching (app)/layout.tsx and
  // (app)/categories/page.tsx.
  if (walletsError) throw new Error("Failed to load wallets");
  if (balancesError) throw new Error("Failed to load balances");
  if (membersError) throw new Error("Failed to load members");
  if (invitesError) throw new Error("Failed to load invitations");
  if (groupsError) throw new Error("Failed to load wallet groups");
  if (prefsError) throw new Error("Failed to load wallet preferences");

  const rows = mergeWalletBalances(
    (wallets ?? []) as WalletRow[],
    (balances ?? []) as BalanceRow[],
  );

  if (sentInvitesError) throw new Error("Failed to load sent invitations");

  // `wallet_sort` is validated here rather than trusted: the column has a
  // CHECK, but `profiles` is typed as plain `string` by the generated types,
  // and arrangeWallets takes a union. A value outside the set falls back to
  // "manual" instead of rendering nothing.
  const sort = walletSortInput.safeParse(profile.wallet_sort);
  const sections = arrangeWallets(
    rows,
    groups ?? [],
    prefs ?? [],
    sort.success ? sort.data : "manual",
    new Map((wallets ?? []).map((w) => [w.id, w.created_at])),
  );

  const ownerByWalletId = new Map((wallets ?? []).map((w) => [w.id, w.owner_id]));

  // Grouped per wallet, and narrowed to wallets this person OWNS:
  // `invites_invitee_select` also lets them read invites addressed to
  // themselves, which belong in the PendingInvites banner above, not in
  // someone else's members list.
  const sentByWalletId = new Map<string, SectionInvite[]>();
  for (const i of sentInvites ?? []) {
    if (ownerByWalletId.get(i.wallet_id) !== profile.id) continue;
    const list = sentByWalletId.get(i.wallet_id) ?? [];
    list.push({ id: i.id, invited_email: i.invited_email });
    sentByWalletId.set(i.wallet_id, list);
  }

  const membersByWalletId = new Map<string, Member[]>();
  for (const m of members ?? []) {
    const list = membersByWalletId.get(m.wallet_id) ?? [];
    list.push({ user_id: m.user_id, display_name: m.display_name, role: m.role });
    membersByWalletId.set(m.wallet_id, list);
  }

  const pendingInvites: PendingInvite[] = (invites ?? []).map((i) => ({
    id: i.id,
    wallet_name: i.wallet_name,
  }));

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-6 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Wallets
      </h1>

      <PendingInvites invites={pendingInvites} />

      {/* `currentUserId`, so the list can tell an owned wallet from a
          shared one: Archive is owner-only (spec §5) and `archiveWallet`
          scopes its UPDATE to `owner_id`, so offering it on a shared row
          could only ever produce a zero-row UPDATE reported as success. */}
      {/* Members and the invite form are handed to WalletList as per-wallet
          slots so each renders INSIDE its own wallet's card. Rendering them
          in a separate block below the list detached them from their
          wallets: with two wallets you saw two identical "MEMBERS"
          headings stacked underneath, with nothing visible saying which
          belonged to which. Containment fixes that structurally. */}
      <WalletList
        sections={sections}
        groups={groups ?? []}
        sort={sort.success ? sort.data : "manual"}
        currentUserId={profile.id}
        memberSections={Object.fromEntries(
          rows.map((w) => [
            w.id,
            <section key={w.id} aria-labelledby={`members-heading-${w.id}`}>
            {/* Visible text is just "Members" — WalletList above already
                renders `w.name` as plain text, and a Playwright
                `getByText(walletName)` lookup elsewhere in this app's e2e
                suite (e2e/ledger.spec.ts) uses substring matching, so
                repeating the name here as visible text would make that
                locator ambiguous. `aria-label` (not read by that substring
                text match, only by assistive tech and accessible-name
                lookups) is what actually disambiguates this heading from
                another wallet's identical "Members" heading for a screen
                reader user navigating by headings. */}
            <h2
              id={`members-heading-${w.id}`}
              aria-label={`${w.name} members`}
              className="mb-3 text-sm font-medium uppercase tracking-wide"
              style={{ color: "var(--ink-2)" }}
            >
              Members
            </h2>
              <MembersSection
                walletId={w.id}
                members={membersByWalletId.get(w.id) ?? []}
                pendingInvites={sentByWalletId.get(w.id) ?? []}
                isOwner={ownerByWalletId.get(w.id) === profile.id}
              />
            </section>,
          ]),
        )}
        /* Bound ACTIONS, not rendered forms. WalletList already holds
            every wallet's data, so handing it the capability rather than
            the markup lets it render the form itself — and therefore know
            when a save succeeded and close its own dialog. A Server
            Component cannot pass a callback to a Client Component, but it
            can pass a server action, which is what makes this work.

            `updateWallet.bind(null, w.id)` fixes the action to one wallet:
            the id never travels in the FormData, so a crafted POST cannot
            retarget the edit, and the action's own `.eq("owner_id",
            user.id)` still scopes it server-side.

            Only for wallets the viewer OWNS. updateWallet's UPDATE is
            owner-scoped, so a member's edit would match zero rows and be
            reported as success — the same defect archiveWallet was fixed
            for. Absent rather than disabled, per this file's convention. */
        editActions={Object.fromEntries(
          rows
            .filter((w) => ownerByWalletId.get(w.id) === profile.id)
            .map((w) => [w.id, updateWallet.bind(null, w.id)]),
        )}
      />

      {/* `addWallet`, not `createWallet`: the latter redirects to / on
          success, which is right for onboarding and wrong here — adding a
          second wallet should leave the user looking at their wallets. */}
      <section aria-labelledby="add-wallet-heading" className="mt-8">
        <h2 id="add-wallet-heading" className="mb-3 text-sm font-medium uppercase tracking-wide" style={{ color: "var(--ink-2)" }}>
          Add a wallet
        </h2>
        <WalletForm
          action={addWallet}
          submitLabel="Add wallet"
          pendingLabel="Adding…"
          defaultCurrency={defaultCurrencyFor(rows, profile.base_currency)}
        />
      </section>
    </div>
  );
}
