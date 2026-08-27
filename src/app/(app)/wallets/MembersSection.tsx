"use client";

import { useActionState, useState, useTransition } from "react";
import { inviteToWallet, removeMember, revokeInvite, type InviteState } from "@/server/actions/invites";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

export type Member = { user_id: string; display_name: string; role: "owner" | "member" };

/**
 * The members half of a wallet's card on /wallets: who's in the wallet,
 * plus (owner-only) Remove and the invite form. A Client Component only
 * because both are interactive — the member list itself is fetched in
 * page.tsx (a Server Component) and passed down, the same split
 * WalletList.tsx uses for Archive.
 *
 * `isOwner` is a display decision only, not the enforcement boundary:
 * `members_write` RLS (owner-only `for all` on wallet_members) and
 * `removeMember`'s own re-check of `wallets.owner_id` are what actually
 * block a non-owner — this component just avoids OFFERING a control that
 * cannot succeed for anyone who isn't the owner, including a non-owner who
 * opens devtools and finds nothing to click in the first place.
 */
export type PendingInvite = { id: string; invited_email: string };

export function MembersSection({
  walletId,
  members,
  pendingInvites,
  isOwner,
}: {
  walletId: string;
  members: Member[];
  /** Invitations this wallet's owner has sent that nobody has answered yet.
   *  Shown so a sent invite is visible rather than only discoverable by
   *  hitting the duplicate-invite error. */
  pendingInvites: PendingInvite[];
  isOwner: boolean;
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

  const [inviteState, inviteAction] = useActionState<InviteState, FormData>(
    inviteToWallet.bind(null, walletId),
    {},
  );

  function remove(userId: string) {
    setError(null);
    setPendingId(userId);
    start(async () => {
      // `removeMember` RETURNS its error rather than throwing — a thrown
      // message would reach the browser as an opaque digest in production
      // (see that action's own doc comment).
      const res = await removeMember(walletId, userId);
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
        {members.map((m) => {
          const removing = pendingId === m.user_id;
          return (
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
              {isOwner && m.role !== "owner" && (
                <button
                  type="button"
                  aria-label={`Remove ${m.display_name}`}
                  disabled={removing}
                  onClick={() => remove(m.user_id)}
                  className={`shrink-0 text-xs underline disabled:opacity-60 ${FOCUS_RING}`}
                  style={{ color: "var(--ink-2)" }}
                >
                  {removing ? "Removing…" : "Remove"}
                </button>
              )}
            </li>
          );
        })}

        {/* Pending invitees sit in the SAME list as members, after them.
            They are prospective members of this wallet, and a separate
            heading would imply a separate concern. "Pending" as text, not
            styling alone — the state has to survive being read aloud. */}
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

      {isOwner && (
        <form action={inviteAction} className="flex items-end gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs" style={{ color: "var(--ink-2)" }}>
              Invite by email
            </span>
            <input
              type="email"
              name="email"
              required
              placeholder="name@example.com"
              autoComplete="off"
              className={`rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`}
              style={{ borderColor: "var(--ink-2)" }}
            />
          </label>
          <button
            type="submit"
            className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium ${FOCUS_RING}`}
            style={{ background: "var(--cat-1)", color: "var(--surface)" }}
          >
            Send invitation
          </button>
        </form>
      )}

      {isOwner && (
        // `role="status"` here, not `role="alert"`, so this stays distinct
        // from the Remove-error alert above: both are always-mounted, and
        // two simultaneous `role="alert"` nodes make `getByRole("alert")`
        // ambiguous for anything (tests included) that queries by role
        // alone. `status` (implicit aria-live="polite") still gets the
        // invite result announced.
        <p role="status" className="text-sm" style={{ color: inviteState.error ? "var(--neg)" : "var(--ink-2)" }}>
          {inviteState.error ?? inviteState.notice}
        </p>
      )}
    </div>
  );
}
