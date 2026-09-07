"use client";

import { useState, useTransition } from "react";
import { inviteToWallet, revokeInvite } from "@/server/actions/invites";
import { InviteByEmailForm } from "@/components/InviteByEmailForm";
import { WalletSharingRow, type SharingMember } from "@/components/WalletSharingRow";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

export type Member = { user_id: string; display_name: string; role: "owner" | "member" };

/**
 * The members half of a wallet's card on /wallets: who's in the wallet,
 * the same household-sharing control /household uses (WalletSharingRow),
 * pending invitees, and (owner-only) the invite form. A Client Component
 * only because all of those are interactive — the member list itself is
 * fetched in page.tsx (a Server Component) and passed down, the same split
 * WalletList.tsx uses for Archive.
 *
 * `isOwner` is a display decision only, not the enforcement boundary:
 * `set_wallet_sharing` (0025) re-checks `wallets.owner_id` itself — this
 * component just avoids OFFERING a control that cannot succeed for anyone
 * who isn't the owner, including a non-owner who opens devtools and finds
 * nothing to click in the first place. Per-person Remove is gone: sharing
 * a wallet with a specific household member (or the whole household) is
 * now managed entirely through WalletSharingRow's switch and checkboxes,
 * which `set_wallet_sharing` treats as the full, replace-in-place state of
 * who can see this wallet.
 */
export type PendingInvite = { id: string; invited_email: string };

export function MembersSection({
  walletId,
  walletName,
  members,
  pendingInvites,
  isOwner,
  householdShared,
  householdMembers,
}: {
  walletId: string;
  walletName: string;
  members: Member[];
  /** Invitations this wallet's owner has sent that nobody has answered yet.
   *  Shown so a sent invite is visible rather than only discoverable by
   *  hitting the duplicate-invite error. */
  pendingInvites: PendingInvite[];
  isOwner: boolean;
  /** Whether this wallet is shared with everyone in its household. */
  householdShared: boolean;
  /** Every member of this wallet's household except its owner, each with
   *  how (if at all) they currently see this wallet. */
  householdMembers: SharingMember[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, start] = useTransition();

  function revoke(inviteId: string) {
    setError(null);
    setPendingId(inviteId);
    start(async () => {
      const res = await revokeInvite(walletId, inviteId);
      if (res.error) setError(res.error);
      setPendingId(null);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Always mounted, not conditionally rendered — same reasoning as
          WalletList's alert paragraph: a role="alert" node that appears and
          gets its text in the same instant is not reliably announced. */}
      <p role="alert" className="text-sm" style={{ color: "var(--neg)" }}>
        {error}
      </p>

      <ul className="flex flex-col">
        {members.map((m) => (
          <li
            key={m.user_id}
            className="flex items-center gap-3 border-b px-1 py-2"
            style={{ borderColor: "var(--grid)" }}
          >
            <span className="min-w-0 flex-1 truncate" style={{ color: "var(--ink)" }}>
              {m.display_name}
            </span>
            {m.role === "owner" && (
              <span className="shrink-0 text-xs" style={{ color: "var(--ink-2)" }}>
                Owner
              </span>
            )}
          </li>
        ))}
      </ul>

      <WalletSharingRow
        walletId={walletId}
        walletName={walletName}
        householdShared={householdShared}
        members={householdMembers}
        canEdit={isOwner}
      />

      {/* Pending invitees sit in their own list, after members and sharing.
          They are prospective members of this wallet, distinct from both
          the roster above and household sharing below. */}
      <ul className="flex flex-col">
        {pendingInvites.map((inv) => {
          const revoking = pendingId === inv.id;
          return (
            <li
              key={inv.id}
              className="flex items-center gap-3 border-b py-2"
              style={{ borderColor: "var(--grid)" }}
            >
              <span className="min-w-0 flex-1 truncate" style={{ color: "var(--ink-2)" }}>
                {inv.invited_email}
              </span>
              <span className="shrink-0 text-xs" style={{ color: "var(--ink-2)" }}>
                Pending
              </span>
              {isOwner && (
                <button
                  type="button"
                  aria-label={`Revoke invitation to ${inv.invited_email}`}
                  disabled={revoking}
                  onClick={() => revoke(inv.id)}
                  className={`shrink-0 text-xs underline disabled:opacity-60 ${FOCUS_RING}`}
                  style={{ color: "var(--ink-2)" }}
                >
                  {revoking ? "Withdrawing…" : "Revoke"}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {isOwner && <InviteByEmailForm action={inviteToWallet.bind(null, walletId)} />}
    </div>
  );
}
