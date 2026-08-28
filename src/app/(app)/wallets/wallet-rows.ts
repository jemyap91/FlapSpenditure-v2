import { CURRENCY_CODES, type WalletInput } from "@/lib/validation/wallet";

export type WalletRow = {
  id: string;
  /** Carried through to the UI, not just used for reads: /wallets lists
   *  SHARED wallets (spec §4) while `archiveWallet` is scoped to
   *  `owner_id = auth.uid()` by design (spec §5), so the list has to know
   *  which rows the viewer actually owns before it offers Archive. */
  owner_id: string;
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

/**
 * Which currency the "Add a wallet" form should start on.
 *
 * Almost nobody's second wallet is in a different currency from their
 * first, so the person's OWN wallets are a better default than a constant
 * — a hardcoded "USD" made someone with two SGD wallets re-pick SGD every
 * time. Derived rather than stored, so it stays right on its own if their
 * mix changes; there is no setting to keep in sync.
 *
 * `fallback` is the profile's `base_currency`, used at onboarding when
 * there are no wallets yet to learn from.
 *
 * A code the form cannot offer is ignored: `CURRENCY_CODES` is a strict
 * subset of what the column allows, and a `<select>` handed a value with no
 * matching `<option>` renders blank rather than defaulting to anything.
 */
export function defaultCurrencyFor(
  wallets: readonly Pick<WalletRow, "currency_code">[],
  fallback: string,
): string {
  const counts = new Map<string, number>();
  for (const w of wallets) {
    if (!(CURRENCY_CODES as readonly string[]).includes(w.currency_code)) continue;
    counts.set(w.currency_code, (counts.get(w.currency_code) ?? 0) + 1);
  }
  if (counts.size === 0) return fallback;

  // Sorted by count, then by code — a Map preserves insertion order, so
  // without the second key a tie would resolve by whatever order the rows
  // happened to arrive in.
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}