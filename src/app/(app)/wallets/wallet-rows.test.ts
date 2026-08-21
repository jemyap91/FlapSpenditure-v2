import { describe, expect, it } from "vitest";
import { mergeWalletBalances, type BalanceRow, type WalletRow } from "./wallet-rows";

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
