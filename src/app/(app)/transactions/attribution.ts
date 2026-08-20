export type MemberRow = {
  wallet_id: string;
  user_id: string;
  display_name: string;
};

export type AttributableTxn = {
  wallet_id: string;
  created_by: string | null;
};

/** A wallet is "shared" (attribution-eligible) once a SECOND distinct
 *  user_id shows up for it in the get_wallet_members() result. */
function sharedWalletIdsOf(members: readonly MemberRow[]): Set<string> {
  const countByWallet = new Map<string, number>();
  for (const m of members) {
    countByWallet.set(m.wallet_id, (countByWallet.get(m.wallet_id) ?? 0) + 1);
  }
  return new Set([...countByWallet.entries()].filter(([, count]) => count > 1).map(([id]) => id));
}

/**
 * Resolves `created_by_name` for a set of transactions against a
 * `get_wallet_members()` result — gated PER ROW on that row's OWN wallet
 * being shared (`sharedWalletIdsOf`, >1 member), never on anything
 * page-wide.
 *
 * Round-1 review caught this as a Critical: an earlier version gated the
 * lookup only on `r.created_by` being non-null. `get_wallet_members()`
 * filters solely on `is_wallet_member(wm.wallet_id)`
 * (0010_invite_and_member_visibility.sql), with NO member-count threshold,
 * so it returns a row for a caller's SOLO wallet too —
 * `{wallet_id: soloId, user_id: self, display_name: <you>}`. Without this
 * row's own gate, a solo-wallet, self-authored transaction would resolve a
 * non-null name the instant it shared a page with even one transaction
 * from a genuinely shared wallet (the caller's page-level `showAttribution`
 * would already be true, and nothing here would leave the solo row's name
 * null to stop it rendering) — "added by <you>" on a private wallet's
 * rows, exactly the noise this feature exists to eliminate.
 * `attribution.test.ts`'s "mixed page" tests reproduce that scenario
 * directly (one solo-wallet row, one shared-wallet row, same caller as
 * author of both) and fail without this row-level gate.
 */
export function resolveCreatedByNames<T extends AttributableTxn>(
  rows: readonly T[],
  members: readonly MemberRow[],
): Array<T & { created_by_name: string | null }> {
  const nameByWalletAndUser = new Map(
    members.map((m) => [`${m.wallet_id}:${m.user_id}`, m.display_name] as const),
  );
  const sharedWalletIds = sharedWalletIdsOf(members);
  return rows.map((r) => ({
    ...r,
    created_by_name:
      r.created_by && sharedWalletIds.has(r.wallet_id)
        ? (nameByWalletAndUser.get(`${r.wallet_id}:${r.created_by}`) ?? null)
        : null,
  }));
}

/** Whether ANY of the given rows' wallets is shared — the page-level
 *  `showAttribution` boolean passed to `TransactionList`. */
export function anyRowShared(rows: readonly AttributableTxn[], members: readonly MemberRow[]): boolean {
  const sharedWalletIds = sharedWalletIdsOf(members);
  return rows.some((r) => sharedWalletIds.has(r.wallet_id));
}
