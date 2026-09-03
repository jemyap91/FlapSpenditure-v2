import { describe, expect, it } from "vitest";
import {
  mergeWalletBalances,
  defaultCurrencyFor,
  arrangeWallets,
  type BalanceRow,
  type WalletRow,
  type WalletWithBalance,
  type WalletGroup,
  type WalletPref,
} from "./wallet-rows";

const wallet = (id: string, over: Partial<WalletRow> = {}): WalletRow => ({
  id,
  // `mergeWalletBalances` never reads `owner_id` — it is carried through by
  // the spread so /wallets can decide whose Archive control to render — but
  // the type requires it, so the fixture supplies a constant one.
  owner_id: "11111111-1111-4111-8111-111111111111",
  name: `Wallet ${id}`,
  kind: "bank",
  currency_code: "USD",
  color_slot: 1,
  icon: "landmark",
  starting_balance_minor: 0,
  ...over,
});

const balance = (wallet_id: string, balance_minor: number): BalanceRow => ({
  wallet_id,
  balance_minor,
  currency_code: "USD",
});

describe("mergeWalletBalances", () => {
  it("attaches each wallet's balance by id", () => {
    const rows = mergeWalletBalances([wallet("a"), wallet("b")], [balance("b", 250), balance("a", -100)]);
    expect(rows.map((r) => [r.id, r.balanceMinor])).toEqual([
      ["a", -100],
      ["b", 250],
    ]);
  });

  it("preserves the wallets' own order, not the balance rows' order", () => {
    const rows = mergeWalletBalances([wallet("a"), wallet("b")], [balance("b", 1), balance("a", 2)]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("gives a wallet with no balance row null, NOT zero", () => {
    // The wallet query and the RPC are two round trips, not one transaction:
    // a wallet created between them appears in one and not the other. Zero
    // would state a balance this app never actually computed.
    const rows = mergeWalletBalances([wallet("a")], []);
    expect(rows[0]!.balanceMinor).toBeNull();
  });

  it("keeps a genuine zero balance distinct from a missing one", () => {
    const rows = mergeWalletBalances([wallet("a")], [balance("a", 0)]);
    expect(rows[0]!.balanceMinor).toBe(0);
  });

  it("ignores balance rows for wallets that aren't listed", () => {
    // get_wallet_balances() spans every wallet the caller is a MEMBER of,
    // while this page lists wallets it can read — an orphan balance must
    // not invent a row.
    const rows = mergeWalletBalances([wallet("a")], [balance("a", 5), balance("ghost", 999)]);
    expect(rows).toHaveLength(1);
  });

  it("carries the wallet's descriptive fields through untouched", () => {
    const rows = mergeWalletBalances(
      [wallet("a", { name: "Travel card", kind: "card", currency_code: "JPY", color_slot: 4, icon: "credit-card" })],
      [balance("a", 700)],
    );
    expect(rows[0]).toMatchObject({
      name: "Travel card",
      kind: "card",
      currency_code: "JPY",
      color_slot: 4,
      icon: "credit-card",
    });
  });
});

describe("defaultCurrencyFor", () => {
  it("uses the currency the person's existing wallets already use", () => {
    expect(defaultCurrencyFor([wallet("a", { currency_code: "SGD" })], "USD")).toBe("SGD");
  });

  it("picks the most common when they are mixed, not merely the first", () => {
    const rows = [
      wallet("a", { currency_code: "USD" }),
      wallet("b", { currency_code: "SGD" }),
      wallet("c", { currency_code: "SGD" }),
    ];
    expect(defaultCurrencyFor(rows, "USD")).toBe("SGD");
  });

  it("falls back to the profile's base currency when there are no wallets yet", () => {
    // The onboarding case: the first wallet has nothing to match.
    expect(defaultCurrencyFor([], "SGD")).toBe("SGD");
  });

  it("breaks a tie deterministically rather than by object iteration order", () => {
    // Two of each: the answer must not depend on how the rows arrived.
    const a = [wallet("a", { currency_code: "USD" }), wallet("b", { currency_code: "SGD" })];
    const b = [wallet("b", { currency_code: "SGD" }), wallet("a", { currency_code: "USD" })];
    expect(defaultCurrencyFor(a, "EUR")).toBe(defaultCurrencyFor(b, "EUR"));
  });

  it("ignores a currency the form cannot offer, rather than selecting nothing", () => {
    // A wallet could hold a code that is no longer in CURRENCY_CODES; a
    // <select> given a value with no matching <option> renders blank.
    expect(defaultCurrencyFor([wallet("a", { currency_code: "ZZZ" })], "SGD")).toBe("SGD");
  });
});

describe("arrangeWallets", () => {
  const w = (id: string, name: string): WalletWithBalance => ({
    ...wallet(id, { name }),
    balanceMinor: 0,
  });
  const alpha = w("a", "Alpha");
  const bravo = w("b", "Bravo");
  const carol = w("c", "Carol");
  const all = [carol, alpha, bravo]; // deliberately unsorted on the way in

  const g = (id: string, name: string, sort_order: number): WalletGroup => ({
    id,
    name,
    sort_order,
  });
  const pref = (wallet_id: string, group_id: string | null, sort_order = 0): WalletPref => ({
    wallet_id,
    group_id,
    sort_order,
  });

  it("puts everything in one ungrouped section when there are no groups", () => {
    const out = arrangeWallets(all, [], [], "name");
    expect(out).toHaveLength(1);
    expect(out[0]!.group).toBeNull();
    expect(out[0]!.wallets.map((x) => x.name)).toEqual(["Alpha", "Bravo", "Carol"]);
  });

  it("orders sections by the group's sort_order, ungrouped last", () => {
    const groups = [g("g2", "Savings", 1), g("g1", "Everyday", 0)];
    const prefs = [pref("a", "g1"), pref("b", "g2")];
    const out = arrangeWallets(all, groups, prefs, "name");
    expect(out.map((s) => s.group?.name ?? "(ungrouped)")).toEqual([
      "Everyday",
      "Savings",
      "(ungrouped)",
    ]);
    expect(out[2]!.wallets.map((x) => x.name)).toEqual(["Carol"]);
  });

  it("keeps the grouping when sorting by name", () => {
    // The regression this guards: sorting collapsing the sections would look
    // exactly like the sort having deleted the user's arrangement.
    const groups = [g("g1", "Everyday", 0)];
    const prefs = [pref("a", "g1"), pref("c", "g1")];
    const out = arrangeWallets(all, groups, prefs, "name");
    expect(out[0]!.group!.name).toBe("Everyday");
    expect(out[0]!.wallets.map((x) => x.name)).toEqual(["Alpha", "Carol"]);
  });

  it("sorts by created_at when asked, not by name", () => {
    const created = new Map([
      ["a", "2026-03-01T00:00:00Z"],
      ["b", "2026-01-01T00:00:00Z"],
      ["c", "2026-02-01T00:00:00Z"],
    ]);
    const out = arrangeWallets(all, [], [], "created", created);
    expect(out[0]!.wallets.map((x) => x.name)).toEqual(["Bravo", "Carol", "Alpha"]);
  });

  it("follows sort_order under manual ordering", () => {
    const prefs = [pref("a", null, 2), pref("b", null, 0), pref("c", null, 1)];
    const out = arrangeWallets(all, [], prefs, "manual");
    expect(out[0]!.wallets.map((x) => x.name)).toEqual(["Bravo", "Carol", "Alpha"]);
  });

  it("breaks a sort_order tie by name, so the list cannot shuffle between visits", () => {
    const prefs = [pref("a", null, 0), pref("b", null, 0), pref("c", null, 0)];
    const out = arrangeWallets(all, [], prefs, "manual");
    expect(out[0]!.wallets.map((x) => x.name)).toEqual(["Alpha", "Bravo", "Carol"]);
  });

  it("keeps a wallet with no preference row rather than dropping it", () => {
    // A wallet shared with you a moment ago has no pref row at all. Losing
    // it here would remove it from the screen entirely.
    const out = arrangeWallets(all, [g("g1", "Everyday", 0)], [pref("a", "g1")], "manual");
    const ungrouped = out.find((s) => s.group === null)!;
    expect(ungrouped.wallets.map((x) => x.name)).toEqual(["Bravo", "Carol"]);
  });

  it("treats a pref pointing at a missing group as ungrouped, never as missing", () => {
    const out = arrangeWallets(all, [], [pref("a", "deleted-group")], "name");
    expect(out).toHaveLength(1);
    expect(out[0]!.wallets.map((x) => x.name)).toEqual(["Alpha", "Bravo", "Carol"]);
  });

  it("renders an empty group, so a newly made one is visible", () => {
    const out = arrangeWallets(all, [g("g1", "Savings", 0)], [], "name");
    expect(out[0]!.group!.name).toBe("Savings");
    expect(out[0]!.wallets).toEqual([]);
  });

  it("keeps an ungrouped section when there are no wallets at all", () => {
    // It carries the "No wallets yet" empty state; returning [] would render
    // nothing whatsoever.
    const out = arrangeWallets([], [], [], "name");
    expect(out).toHaveLength(1);
    expect(out[0]!.group).toBeNull();
  });

  it("omits an empty ungrouped section when every wallet is grouped", () => {
    const groups = [g("g1", "Everyday", 0)];
    const prefs = [pref("a", "g1"), pref("b", "g1"), pref("c", "g1")];
    const out = arrangeWallets(all, groups, prefs, "name");
    expect(out).toHaveLength(1);
    expect(out[0]!.group!.name).toBe("Everyday");
  });

  it("does not mutate its inputs", () => {
    const wallets = [carol, alpha, bravo];
    const groups = [g("g2", "B", 1), g("g1", "A", 0)];
    arrangeWallets(wallets, groups, [], "name");
    expect(wallets.map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(groups.map((x) => x.id)).toEqual(["g2", "g1"]);
  });
});
