"use client";

import { useState, useTransition } from "react";
import { respondToInvite } from "@/server/actions/invites";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

export type PendingInvite = { id: string; wallet_name: string };

/**
 * Invitations addressed to the signed-in user, listed above their own
 * wallets on /wallets. `invites_invitee_select` RLS (0009) already scopes
 * the page's query to invites whose `invited_email` matches the caller's
 * JWT email, so every row this component receives is one this user may act
 * on — no further filtering happens here.
 *
 * Renders nothing when there are no pending invites, so the common case
 * (no invites) costs no space on the page — no empty heading, no empty
 * list, nothing.
 */
export function PendingInvites({ invites }: { invites: PendingInvite[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, start] = useTransition();

  function respond(id: string, accept: boolean) {
    setError(null);
    setPendingId(id);
    start(async () => {
      // `respondToInvite` RETURNS its error rather than throwing — a thrown
      // message would reach the browser as an opaque digest in production
      // (see that action's own doc comment).
      const res = await respondToInvite(id, accept);
      if (res.error) setError(res.error);
      setPendingId(null);
    });
  }

  if (!invites.length) return null;

  return (
    <section aria-labelledby="pending-invites-heading" className="mb-8">
      <h2
        id="pending-invites-heading"
        className="mb-3 text-sm font-medium uppercase tracking-wide"
        style={{ color: "var(--ink-2)" }}
      >
        Pending invitations
      </h2>

      {/* Always mounted, not conditionally rendered — same reasoning as
          WalletList's alert paragraph: a role="alert" node that appears and
          gets its text in the same instant is not reliably announced. */}
      <p role="alert" className="mb-2 text-sm" style={{ color: "var(--neg)" }}>
        {error}
      </p>

      <ul className="flex flex-col">
        {invites.map((inv) => {
          const responding = pendingId === inv.id;
          return (
            <li
              key={inv.id}
              className="flex items-center gap-3 border-b px-1 py-3"
              style={{ borderColor: "var(--grid)" }}
            >
              <span className="min-w-0 flex-1 truncate" style={{ color: "var(--ink)" }}>
                {inv.wallet_name}
              </span>
              <button
                type="button"
                disabled={responding}
                onClick={() => respond(inv.id, true)}
                className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
                style={{ background: "var(--cat-1)", color: "var(--surface)" }}
              >
                Accept
              </button>
              <button
                type="button"
                disabled={responding}
                onClick={() => respond(inv.id, false)}
                className={`shrink-0 text-sm underline disabled:opacity-60 ${FOCUS_RING}`}
                style={{ color: "var(--ink-2)" }}
              >
                Decline
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
