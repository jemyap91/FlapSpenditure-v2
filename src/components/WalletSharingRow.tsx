"use client";

import { useId, useState, useTransition } from "react";
import { setWalletSharing } from "@/server/actions/household";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

export type SharingMember = {
  user_id: string;
  display_name: string;
  via: "owner" | "household" | "direct" | null;
};

/**
 * A React `key` for one of these rows, spelling out every prop it copies
 * into local state on mount. Both parents key the row with this, so a
 * revalidation that brings NEW sharing data remounts the row on it instead
 * of leaving the stale copy in place — a member removed from the household
 * must stop being offered a checkbox here. (The local copy exists so an
 * unsaved edit survives an unrelated re-render; a key is the smallest fix
 * that keeps that and still follows the server.)
 */
export function sharingKey(
  wallet: { id: string; shared_with_household: boolean },
  members: SharingMember[],
) {
  return `${wallet.id}:${wallet.shared_with_household}:${members
    .map((m) => `${m.user_id}=${m.via ?? "-"}`)
    .join(",")}`;
}

/**
 * One wallet's sharing, rendered the same way on /household (one row of the
 * grid) and /wallets (under the wallet). The switch shares with everyone in
 * the household; a checkbox is a DIRECT share that survives turning the
 * switch off later (set_wallet_sharing, 0025: direct outranks household).
 * Save submits the whole row, so what you see is exactly what is stored.
 */
export function WalletSharingRow({
  walletId,
  walletName,
  householdShared,
  members,
  canEdit,
}: {
  walletId: string;
  walletName: string;
  householdShared: boolean;
  members: SharingMember[];
  canEdit: boolean;
}) {
  const [household, setHousehold] = useState(householdShared);
  const [direct, setDirect] = useState<Set<string>>(
    () => new Set(members.filter((m) => m.via === "direct").map((m) => m.user_id)),
  );
  const [status, setStatus] = useState<{ error?: string; notice?: string }>({});
  const [saving, start] = useTransition();
  const statusId = useId();

  function label(m: SharingMember) {
    if (m.via === "household") return `${m.display_name} · via household`;
    if (m.via === "direct") return `${m.display_name} · direct`;
    return `${m.display_name} · no access`;
  }

  function save() {
    setStatus({});
    start(async () => {
      const res = await setWalletSharing(walletId, household, [...direct]);
      setStatus(res);
    });
  }

  return (
    <div className="flex flex-col gap-2" aria-describedby={statusId}>
      {canEdit ? (
        <label className="flex items-center gap-2 text-sm" style={{ color: "var(--ink)" }}>
          <input
            type="checkbox"
            role="switch"
            aria-label={`Share ${walletName} with the whole household`}
            checked={household}
            onChange={(e) => setHousehold(e.target.checked)}
          />
          Share with the whole household
        </label>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-sm" style={{ color: "var(--ink-2)" }}>
            {householdShared ? "Shared with the whole household." : "Not shared with the household."}
          </p>
          <p className="text-sm" style={{ color: "var(--ink-2)" }}>
            Only the wallet&apos;s owner can change this.
          </p>
        </div>
      )}
      <ul className="flex flex-col gap-1" aria-label={`${walletName} access`}>
        {members.map((m) => (
          <li key={m.user_id} className="flex items-center gap-2 text-sm" style={{ color: "var(--ink)" }}>
            {canEdit && (
              <input
                type="checkbox"
                aria-label={`Share ${walletName} directly with ${m.display_name}`}
                checked={direct.has(m.user_id)}
                onChange={(e) => {
                  const next = new Set(direct);
                  if (e.target.checked) next.add(m.user_id);
                  else next.delete(m.user_id);
                  setDirect(next);
                }}
              />
            )}
            <span>{label(m)}</span>
          </li>
        ))}
      </ul>
      {canEdit && (
        <button
          type="button"
          onClick={save}
          disabled={saving}
          aria-label={`Save sharing for ${walletName}`}
          className={`self-start rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${FOCUS_RING}`}
          style={{ background: "var(--cat-1)", color: "var(--surface)" }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      )}
      {/* Always mounted: a live region that appears with its text is not
          reliably announced (WalletList's own alert paragraph). */}
      <p id={statusId} role="status" className="text-sm" style={{ color: status.error ? "var(--neg)" : "var(--ink-2)" }}>
        {status.error ?? status.notice}
      </p>
    </div>
  );
}
