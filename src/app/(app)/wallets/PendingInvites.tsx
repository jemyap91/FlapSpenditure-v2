"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { respondToInvite } from "@/server/actions/invites";
import { respondToHouseholdInvite } from "@/server/actions/household";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

export type PendingInvite = { id: string; kind: "wallet" | "household"; name: string };

/**
 * Invitations addressed to the signed-in user, listed above their own
 * wallets on /wallets — both wallet invites (`invites_invitee_select` RLS,
 * 0009) and household invites (`get_pending_space_invites`, 0025), so a
 * person invited into a whole household sees that offer in the same place
 * as a single-wallet invite rather than having to already know /household
 * exists.
 *
 * `invites_invitee_select` already scopes the wallet-invite half of the
 * page's query to invites whose `invited_email` matches the caller's JWT
 * email, and `get_pending_space_invites` is a SECURITY DEFINER RPC that
 * self-scopes the same way — every row this component receives is one this
 * user may act on, no further filtering happens here.
 *
 * Renders nothing when there are no pending invites, so the common case
 * (no invites) costs no space on the page — no empty heading, no empty
 * list, nothing.
 */
export function PendingInvites({ invites }: { invites: PendingInvite[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, start] = useTransition();

  function respond(invite: PendingInvite, accept: boolean) {
    setError(null);
    setPendingId(invite.id);
    start(async () => {
      // Both actions RETURN their error rather than throwing — a thrown
      // message would reach the browser as an opaque digest in production
      // (see each action's own doc comment).
      const res =
        invite.kind === "household"
          ? await respondToHouseholdInvite(invite.id, accept)
          : await respondToInvite(invite.id, accept);
      if (res.error) setError(res.error);
      setPendingId(null);
    });
  }

  if (!invites.length) return null;

  const hasHouseholdInvite = invites.some((inv) => inv.kind === "household");

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
                {inv.kind === "wallet" ? `Join wallet ${inv.name}` : `Join ${inv.name}`}
              </span>
              <button
                type="button"
                disabled={responding}
                onClick={() => respond(inv, true)}
                className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
                style={{ background: "var(--cat-1)", color: "var(--surface)" }}
              >
                Accept
              </button>
              <button
                type="button"
                disabled={responding}
                onClick={() => respond(inv, false)}
                className={`shrink-0 text-sm underline disabled:opacity-60 ${FOCUS_RING}`}
                style={{ color: "var(--ink-2)" }}
              >
                Decline
              </button>
            </li>
          );
        })}
      </ul>

      {hasHouseholdInvite && (
        <Link href="/household" className={`mt-2 inline-block text-sm underline ${FOCUS_RING}`} style={{ color: "var(--ink-2)" }}>
          Manage households
        </Link>
      )}
    </section>
  );
}
