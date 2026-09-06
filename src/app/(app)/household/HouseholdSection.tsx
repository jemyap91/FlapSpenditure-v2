"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import {
  inviteToHousehold,
  leaveHousehold,
  removeHouseholdMember,
  revokeHouseholdInvite,
} from "@/server/actions/household";
import { InviteByEmailForm } from "@/components/InviteByEmailForm";
import { WalletSharingRow, sharingKey, type SharingMember } from "@/components/WalletSharingRow";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

export type HouseholdMember = { user_id: string; display_name: string; role: "owner" | "member" };
export type HouseholdWallet = {
  id: string; name: string; owner_id: string; shared_with_household: boolean; archived_at: string | null;
};
export type HouseholdInvite = { id: string; invited_email: string };
type Access = { wallet_id: string; user_id: string; via: "owner" | "household" | "direct" };

export type HouseholdSectionProps = {
  space: { id: string; name: string };
  currentUserId: string;
  members: HouseholdMember[];
  wallets: HouseholdWallet[];
  access: Access[];
  pendingInvites: HouseholdInvite[];
  single: boolean;
};

/**
 * One household: members, invitations, leave/remove, and the sharing grid.
 * Membership is managed by the household OWNER; each wallet's sharing by
 * that wallet's OWNER (WalletSharingRow's `canEdit`). Leave and Remove both
 * open an in-page confirm (role="dialog", not window.confirm: the app's own
 * dialogs are what its tests and screen-reader users already handle) that
 * states what moves with the person before anything is sent.
 *
 * `onLeft`, when given, is called instead of setting this section's own
 * status on a SUCCESSFUL leave. Leaving is the one action here that makes
 * THIS SPACE disappear from the next page load — the very re-render that
 * would show "you left" also removes this component (keyed by space.id)
 * from the tree, so a notice held in this component's own state never
 * gets to paint. `HouseholdSections` passes a setter that lives one level
 * up, outside any single space's key, so the message survives. Removing a
 * MEMBER has no such problem (the acting owner's own section persists),
 * so that path is untouched.
 */
export function HouseholdSection({
  space, currentUserId, members, wallets, access, pendingInvites, single, onLeft,
}: HouseholdSectionProps & { onLeft?: (notice: string) => void }) {
  const isOwner = members.some((m) => m.user_id === currentUserId && m.role === "owner");
  const headingId = useId();
  const [confirm, setConfirm] = useState<{ kind: "leave" } | { kind: "remove"; member: HouseholdMember } | null>(null);
  const [status, setStatus] = useState<{ error?: string; notice?: string }>({});
  const [busy, start] = useTransition();

  // The confirm panel is a dialog, so it behaves like one: focus lands on
  // its primary button when it opens, Escape closes it, and dismissing it
  // hands focus back to the control that opened it. Without this a keyboard
  // user's focus stays on a button behind a panel they cannot see and
  // cannot leave.
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (confirm) confirmButtonRef.current?.focus();
  }, [confirm]);

  function openConfirm(
    target: { kind: "leave" } | { kind: "remove"; member: HouseholdMember },
    opener: HTMLElement,
  ) {
    openerRef.current = opener;
    setConfirm(target);
  }

  function dismissConfirm() {
    setConfirm(null);
    // The opener is still mounted on a cancel — nothing has changed yet.
    openerRef.current?.focus();
    openerRef.current = null;
  }

  function runConfirm() {
    if (!confirm) return;
    const target = confirm;
    setConfirm(null);
    // Not returned: the button that opened this is about to be replaced
    // (a removed member's row goes; a leave unmounts the whole section).
    openerRef.current = null;
    setStatus({});
    start(async () => {
      if (target.kind === "leave") {
        const res = await leaveHousehold(space.id);
        // A successful leave is handed to `onLeft` (see this component's
        // doc comment) rather than `setStatus` — this section is about to
        // disappear. An error leaves the person right where they were, so
        // it is shown locally same as every other error here.
        if (res.error) setStatus(res);
        else if (res.notice) onLeft?.(res.notice);
      } else {
        setStatus(await removeHouseholdMember(space.id, target.member.user_id));
      }
    });
  }

  function revoke(id: string) {
    setStatus({});
    start(async () => {
      const res = await revokeHouseholdInvite(id);
      setStatus(res);
    });
  }

  const sorted = members.slice().sort((a, b) =>
    a.role === b.role ? a.display_name.localeCompare(b.display_name) : a.role === "owner" ? -1 : 1,
  );
  const viaFor = (walletId: string, userId: string) =>
    access.find((a) => a.wallet_id === walletId && a.user_id === userId)?.via ?? null;

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className={single ? "mb-4 text-lg font-semibold" : "mb-4 text-xl font-semibold"} style={{ color: "var(--ink)" }}>
        {space.name}
      </h2>

      <p role="status" className="mb-3 text-sm" style={{ color: status.error ? "var(--neg)" : "var(--ink-2)" }}>
        {status.error ?? status.notice}
      </p>

      <h3 className="mb-2 text-sm font-medium uppercase tracking-wide" style={{ color: "var(--ink-2)" }}>Members</h3>
      <ul className="mb-4 flex flex-col gap-2" aria-label={`${space.name} members`}>
        {sorted.map((m) => (
          <li key={m.user_id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "var(--grid)", background: "var(--surface)", color: "var(--ink)" }}>
            <span>
              {m.display_name}
              {m.user_id === currentUserId && <span className="ml-2 text-xs" style={{ color: "var(--ink-2)" }}>(you)</span>}
            </span>
            <span className="flex items-center gap-3 text-xs" style={{ color: "var(--ink-2)" }}>
              {m.role === "owner" ? "Owner" : "Member"}
              {isOwner && m.user_id !== currentUserId && (
                <button type="button" disabled={busy}
                        onClick={(e) => openConfirm({ kind: "remove", member: m }, e.currentTarget)}
                        aria-label={`Remove ${m.display_name} from the household`}
                        className={`underline disabled:opacity-60 ${FOCUS_RING}`}>
                  Remove
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      {isOwner && pendingInvites.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2" aria-label={`${space.name} invitations`}>
          {pendingInvites.map((inv) => (
            <li key={inv.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                style={{ borderColor: "var(--grid)", color: "var(--ink-2)" }}>
              <span>{inv.invited_email}</span>
              <span className="flex items-center gap-3 text-xs">
                Pending
                <button type="button" disabled={busy} onClick={() => revoke(inv.id)}
                        aria-label={`Revoke invitation to ${inv.invited_email}`}
                        className={`underline disabled:opacity-60 ${FOCUS_RING}`}>
                  Revoke
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {isOwner ? (
        <div className="mb-6"><InviteByEmailForm action={inviteToHousehold.bind(null, space.id)} /></div>
      ) : (
        <button type="button" disabled={busy} onClick={(e) => openConfirm({ kind: "leave" }, e.currentTarget)}
                className={`mb-6 rounded-md border px-3 py-1.5 text-sm ${FOCUS_RING}`}
                style={{ borderColor: "var(--ink-2)", color: "var(--ink)" }}>
          Leave household
        </button>
      )}

      {confirm && (
        <div role="dialog" aria-modal="true"
             aria-label={confirm.kind === "leave" ? `Leave ${space.name}?` : `Remove ${confirm.member.display_name}?`}
             onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); dismissConfirm(); } }}
             className="mb-6 rounded-lg border p-4" style={{ borderColor: "var(--neg)", background: "var(--surface)" }}>
          {/* "a household of your own", not "a new household": leave_space
              reuses the household you already own from signup (spec §11,
              departure 3) rather than minting one, so it may already have
              other people in it — who then see the copied category NAMES. */}
          <p className="mb-3 text-sm" style={{ color: "var(--ink)" }}>
            {confirm.kind === "leave"
              ? "Wallets you own go with you into a household of your own, with the categories they use. Budgets over your wallets alone go too; budgets shared with others lose your wallets. Transactions you recorded in shared wallets stay here."
              : `Wallets ${confirm.member.display_name} owns go with them into a household of their own, with the categories they use. Budgets over their wallets alone go too; budgets shared with others lose their wallets. Transactions they recorded in shared wallets stay here.`}
          </p>
          <div className="flex gap-2">
            <button type="button" ref={confirmButtonRef} onClick={runConfirm}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium ${FOCUS_RING}`}
                    style={{ background: "var(--neg)", color: "var(--surface)" }}>
              {confirm.kind === "leave" ? "Leave" : "Remove"}
            </button>
            <button type="button" onClick={dismissConfirm} className={`text-sm underline ${FOCUS_RING}`} style={{ color: "var(--ink-2)" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <h3 className="mb-2 text-sm font-medium uppercase tracking-wide" style={{ color: "var(--ink-2)" }}>Who can see which wallet</h3>
      <div className="overflow-x-auto">
        <table aria-label="Who can see which wallet" className="w-full text-sm" style={{ color: "var(--ink)" }}>
          <thead>
            <tr>
              <th scope="col" className="py-1 text-left font-medium">Wallet</th>
              <th scope="col" className="py-1 text-left font-medium">Sharing</th>
            </tr>
          </thead>
          <tbody>
            {wallets.map((w) => {
              const others: SharingMember[] = sorted
                .filter((m) => m.user_id !== w.owner_id)
                .map((m) => ({ user_id: m.user_id, display_name: m.display_name, via: viaFor(w.id, m.user_id) }));
              const ownerName = members.find((m) => m.user_id === w.owner_id)?.display_name ?? "someone";
              return (
                <tr key={w.id} className="border-t align-top" style={{ borderColor: "var(--grid)" }}>
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    {w.name}
                    <span className="block text-xs font-normal" style={{ color: "var(--ink-2)" }}>
                      {w.owner_id === currentUserId ? "yours" : `${ownerName}'s`}{w.archived_at ? " · archived" : ""}
                    </span>
                  </th>
                  <td className="py-2">
                    {/* Keyed on the sharing state it is given, not just the
                        wallet id: WalletSharingRow copies its props into
                        local state on mount (an unsaved edit must survive a
                        re-render), so a revalidation carrying NEW server
                        data would otherwise be ignored. A changed key
                        remounts the row on that new data. */}
                    <WalletSharingRow key={sharingKey(w, others)}
                                      walletId={w.id} walletName={w.name} householdShared={w.shared_with_household}
                                      members={others} canEdit={w.owner_id === currentUserId} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
