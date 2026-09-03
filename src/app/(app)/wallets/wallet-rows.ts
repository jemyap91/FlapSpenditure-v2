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
  /** The wallet's opening figure, in minor units. Carried to the UI so the
   *  edit form can seed itself: the balance shown on this screen is
   *  `starting_balance_minor + sum(transactions)` and only the opening half
   *  is editable, so the form cannot derive it from the displayed total. */
  starting_balance_minor: number;
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
export type WalletGroup = { id: string; name: string; sort_order: number };
export type WalletPref = { wallet_id: string; group_id: string | null; sort_order: number };

/** One rendered section of the wallets list: a named group, or the trailing
 *  ungrouped one (`group: null`). */
export type WalletSection = { group: WalletGroup | null; wallets: WalletWithBalance[] };

/**
 * Arranges the wallets list into the sections the screen renders, applying
 * the user's own grouping and their chosen ordering.
 *
 * Pure, and separate from page.tsx for the same reason `mergeWalletBalances`
 * is: this is where every ordering rule actually lives, and it is worth
 * testing without a Supabase stack.
 *
 * Grouping is applied under ALL three sort modes, not just "manual". The
 * alternative — groups collapsing whenever you sort by name — would make
 * sorting look like it had deleted the arrangement. The sort chooses the
 * order WITHIN each section, and the sections themselves always run in the
 * user's group order with ungrouped last.
 *
 * `prefs` covers only wallets the user has actually arranged; a wallet they
 * have never touched, or one shared with them a moment ago, simply has no
 * row. Those are ungrouped with sort_order 0, which under manual ordering
 * puts them at the top of the ungrouped section rather than dropping them —
 * a wallet must never disappear from this screen because a preference row is
 * missing.
 *
 * Ties are always broken by name, then by id. Without that, two wallets
 * sharing a sort_order (or a created_at, which a seeded pair can) would
 * render in whatever order the query happened to return, and the list would
 * appear to shuffle itself between visits.
 */
export function arrangeWallets(
  wallets: readonly WalletWithBalance[],
  groups: readonly WalletGroup[],
  prefs: readonly WalletPref[],
  sort: "manual" | "name" | "created",
  /** `created_at` per wallet id. Not on `WalletRow` — the list has never
   *  needed it before — so it is passed alongside rather than widening a
   *  type six other call sites share. A wallet missing from this map sorts
   *  as if created at epoch, which only affects `sort: "created"`. */
  createdAt: ReadonlyMap<string, string> = new Map(),
): WalletSection[] {
  const prefByWallet = new Map(prefs.map((p) => [p.wallet_id, p]));
  const groupById = new Map(groups.map((g) => [g.id, g]));

  const byName = (a: WalletWithBalance, b: WalletWithBalance) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

  const compare = (a: WalletWithBalance, b: WalletWithBalance) => {
    if (sort === "name") return byName(a, b);
    if (sort === "created") {
      const at = createdAt.get(a.id) ?? "";
      const bt = createdAt.get(b.id) ?? "";
      return at.localeCompare(bt) || byName(a, b);
    }
    const ao = prefByWallet.get(a.id)?.sort_order ?? 0;
    const bo = prefByWallet.get(b.id)?.sort_order ?? 0;
    return ao - bo || byName(a, b);
  };

  const buckets = new Map<string | null, WalletWithBalance[]>();
  for (const w of wallets) {
    // A pref pointing at a group that no longer exists is treated as
    // ungrouped rather than dropped. `on delete set null (group_id)` already
    // nulls these, so it should not happen — but a wallet vanishing from the
    // list is a far worse failure than one appearing in the wrong section,
    // and this is the only place that choice can be made.
    const raw = prefByWallet.get(w.id)?.group_id ?? null;
    const key = raw !== null && groupById.has(raw) ? raw : null;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(w);
    else buckets.set(key, [w]);
  }

  const ordered = [...groups].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
  );

  const sections: WalletSection[] = [];
  for (const g of ordered) {
    const inGroup = buckets.get(g.id);
    // Empty groups are still rendered: a user who made "Savings" and has not
    // filed anything into it yet needs to see it exists, and it is the drop
    // target for doing so.
    sections.push({ group: g, wallets: (inGroup ?? []).sort(compare) });
  }
  const ungrouped = buckets.get(null) ?? [];
  // The ungrouped section is omitted only when it is empty AND there is at
  // least one group to show instead — with no groups at all it IS the list,
  // and an empty one carries the "No wallets yet" empty state.
  if (ungrouped.length > 0 || sections.length === 0) {
    sections.push({ group: null, wallets: ungrouped.sort(compare) });
  }
  return sections;
}
