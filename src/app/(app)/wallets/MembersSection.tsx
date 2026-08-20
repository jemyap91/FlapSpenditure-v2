"use client";

import { useActionState, useState, useTransition } from "react";
import { inviteToWallet, removeMember, type InviteState } from "@/server/actions/invites";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

export type Member = { user_id: string; display_name: string; role: "owner" | "member" };

/**
 * The members half of a wallet's card on /wallets: who's in the account,
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
export function MembersSection({
  walletId,
  members,
  isOwner,
}: {
  walletId: string;
  members: Member[];
  isOwner: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, start] = useTransition();

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
