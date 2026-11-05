import { describe, it, expect, vi, beforeEach } from "vitest";
import { setWalletBonus } from "./wallet-bonus";

const WALLET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const { getUser, rpc, revalidatePath, walletRow } = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  revalidatePath: vi.fn(),
  walletRow: { data: null as { currency_code: string } | null },
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    rpc,
    from: (table: string) => {
      if (table !== "wallets") throw new Error(`unexpected table ${table}`);
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve({ data: walletRow.data, error: null }),
      };
      return builder;
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
  walletRow.data = { currency_code: "SGD" };
  rpc.mockResolvedValue({ error: null });
});

describe("setWalletBonus", () => {
  it("converts the max with the wallet's currency, saves once and revalidates", async () => {
    const result = await setWalletBonus({
      wallet_id: WALLET_ID,
      bonus_channel: "online",
      cycle_start_day: 19,
      max: "1000",
    });
    expect(result).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("set_wallet_bonus", {
      p_wallet_id: WALLET_ID,
      p_channel: "online",
      p_cycle_start_day: 19,
      p_cap_minor: 100000,
      p_counts_all_spend: false,
    });
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("clears the terms by omitting every value", async () => {
    await setWalletBonus({ wallet_id: WALLET_ID, bonus_channel: null, cycle_start_day: null, max: null });
    expect(rpc).toHaveBeenCalledWith("set_wallet_bonus", {
      p_wallet_id: WALLET_ID,
      p_channel: undefined,
      p_cycle_start_day: undefined,
      p_cap_minor: undefined,
      p_counts_all_spend: false,
    });
  });

  it("passes 'every expense counts' through, and refuses it without a max", async () => {
    await setWalletBonus({
      wallet_id: WALLET_ID,
      bonus_channel: "bill",
      cycle_start_day: 2,
      max: "500",
      counts_all_spend: true,
    });
    expect(rpc).toHaveBeenCalledWith("set_wallet_bonus", expect.objectContaining({ p_cap_minor: 50000, p_counts_all_spend: true }));

    rpc.mockClear();
    const refused = await setWalletBonus({
      wallet_id: WALLET_ID,
      bonus_channel: "bill",
      cycle_start_day: 2,
      max: null,
      counts_all_spend: true,
    });
    expect(refused).toEqual({ error: "Set a max for every expense to count toward" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns a generic error when the RPC fails", async () => {
    rpc.mockResolvedValue({ error: { message: "boom", code: "XX000" } });
    const result = await setWalletBonus({
      wallet_id: WALLET_ID,
      bonus_channel: "online",
      cycle_start_day: 19,
      max: "1000",
    });
    expect(result).toEqual({ error: "Could not save card terms. Please try again." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses invalid input before touching the database", async () => {
    const result = await setWalletBonus({
      wallet_id: WALLET_ID,
      bonus_channel: "online",
      cycle_start_day: 32,
      max: null,
    });
    expect("error" in result).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not signed in", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const result = await setWalletBonus({
      wallet_id: WALLET_ID,
      bonus_channel: "online",
      cycle_start_day: 19,
      max: "1000",
    });
    expect(result).toEqual({ error: "Not signed in" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reports a wallet the caller cannot see", async () => {
    walletRow.data = null;
    const result = await setWalletBonus({
      wallet_id: WALLET_ID,
      bonus_channel: "online",
      cycle_start_day: 19,
      max: "1000",
    });
    expect(result).toEqual({ error: "Wallet not found" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["abc", "Max is not a valid amount"],
    ["0", "Max must be more than zero"],
  ])("refuses a max of %s", async (max, message) => {
    const result = await setWalletBonus({
      wallet_id: WALLET_ID,
      bonus_channel: "online",
      cycle_start_day: 19,
      max,
    });
    expect(result).toEqual({ error: message });
    expect(rpc).not.toHaveBeenCalled();
  });
});
