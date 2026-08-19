import type { WalletInput } from "@/lib/validation/wallet";

export type WalletRow = {
  id: string;
  name: string;
  kind: WalletInput["kind"];
  currency_code: string;
  color_slot: number;
  icon: string;
};

export type BalanceRow = {
  wallet_id: string;
  balance_minor: number;
  currency_code: string;
};

export type WalletWithBalance = WalletRow & { balanceMinor: number | null };

/**
 * Joins /wallets' two reads: the `wallets` SELECT (which supplies every
 * descriptive field) and the `get_wallet_balances()` RPC (which supplies
 * only `wallet_id`/`balance_minor`/`currency_code`, see
 * supabase/migrations/0006_aggregates.sql). Extracted here rather than
 * inlined in page.tsx so it is unit-testable without a Supabase stack, the
 * same reason src/components/shell/nav-active.ts exists.
 *
 * `wallets` drives the output — order and membership both. The RPC spans
 * every wallet the caller is a MEMBER of, which is not necessarily the set
 * this page lists, so a balance row with no matching wallet is dropped
 * rather than allowed to invent one.
 *
 * A wallet with no balance row gets `null`, never `0`. The two reads are
 * separate round trips, not one transaction, so a wallet created between
 * them legitimately appears in one and not the other — and `0` is a real,
 * common balance that the UI must be able to state honestly. Collapsing
 * "we did not compute this" into "this is zero" would make the two
 * indistinguishable.
 */
export function mergeWalletBalances(
  wallets: readonly WalletRow[],
  balances: readonly BalanceRow[],
): WalletWithBalance[] {
  const byWalletId = new Map(balances.map((b) => [b.wallet_id, b.balance_minor]));
  return wallets.map((w) => ({
    ...w,
    balanceMinor: byWalletId.get(w.id) ?? null,
  }));
}
