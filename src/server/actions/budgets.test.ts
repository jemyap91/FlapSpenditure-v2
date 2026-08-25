// src/server/actions/budgets.test.ts
//
// `./budgets` carries a file-level "use server" and (transitively, through
// `@/lib/supabase/server`) reaches `next/headers` and `server-only` — this
// branch's binding rule says a unit test's import chain must never touch
// those with no `.env.local` present (`npm test` runs with none). `vi.mock`
// below intercepts BOTH `@/lib/supabase/server` and `next/cache` before the
// real modules ever load, following `src/server/actions/invites.test.ts`
// exactly, so this suite exercises the two actions' actual logic — not a
// stand-in — while never constructing a real Supabase client or calling
// into Next's real cache-invalidation machinery (which throws outside a
// request scope).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setBudget, removeBudget } from "./budgets";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WALLET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CATEGORY_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BUDGET_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

/**
 * `vi.hoisted` is required because `vi.mock` factories are hoisted above
 * this file's own top-level `const`s (same note as invites.test.ts).
 */
const {
  getUser,
  membershipLookup,
  walletLookup,
  budgetsDelete,
  budgetsEqCalls,
  rpcResult,
  rpcCalls,
  fromTables,
  revalidatePath,
} = vi.hoisted(() => ({
  getUser: vi.fn(),
  membershipLookup: { data: null as { wallet_id: string } | null, error: null as unknown },
  walletLookup: { data: null as { currency_code: string } | null, error: null as unknown },
  budgetsDelete: { data: [] as { id: string }[] | null, error: null as unknown },
  budgetsEqCalls: [] as unknown[][],
  rpcResult: { error: null as unknown },
  rpcCalls: [] as { fn: string; args: unknown }[],
  fromTables: [] as string[],
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
    from: (table: string) => {
      fromTables.push(table);
      if (table === "wallet_members") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => membershipLookup,
        };
        return builder;
      }
      if (table === "wallets") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => walletLookup,
        };
        return builder;
      }
      if (table === "budgets") {
        const builder: Record<string, unknown> = {
          delete: () => builder,
          eq: (...args: unknown[]) => {
            budgetsEqCalls.push(["eq", ...args]);
            return builder;
          },
          select: () => builder,
          // Real supabase-js query builders are thenable — `removeBudget`
          // relies on that (`await supabase.from(...).delete().eq(...).select(...)`),
          // so the fake needs a `.then`, not a terminal method call.
          then: (resolve: (v: typeof budgetsDelete) => void) => resolve(budgetsDelete),
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const budgetForm = (amount: string) => {
  const fd = new FormData();
  fd.set("amount", amount);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  budgetsEqCalls.length = 0;
  rpcCalls.length = 0;
  fromTables.length = 0;
  membershipLookup.data = { wallet_id: WALLET_ID };
  membershipLookup.error = null;
  walletLookup.data = { currency_code: "USD" };
  walletLookup.error = null;
  budgetsDelete.data = [{ id: BUDGET_ID }];
  budgetsDelete.error = null;
  rpcResult.error = null;
  getUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
});

describe("setBudget", () => {
  it("refuses a non-member with a readable message", async () => {
    membershipLookup.data = null;

    const result = await setBudget(WALLET_ID, CATEGORY_ID, {}, budgetForm("600"));

    expect(result).toEqual({ error: "You do not have access to that account." });
    expect(rpcCalls).toEqual([]);
  });

  it("returns an error, never throws, when set_budget is refused", async () => {
    rpcResult.error = { message: 'new row violates row-level security policy for table "budgets"' };

    const result = await setBudget(WALLET_ID, CATEGORY_ID, {}, budgetForm("600"));

    // App-authored text. The raw provider string above names the table and
    // the policy; forwarding it is the leak this codebase's convention
    // exists to prevent.
    expect(result).toEqual({ error: "Could not save that budget. Please try again." });
    expect(JSON.stringify(result)).not.toContain("row-level security");
  });

  it("rejects a zero amount", async () => {
    const result = await setBudget(WALLET_ID, CATEGORY_ID, {}, budgetForm("0"));

    expect(result).toEqual({ error: "Enter an amount greater than zero." });
    expect(rpcCalls).toEqual([]);
  });

  it("calls set_budget with the first of the current month", async () => {
    const { monthRange } = await import("@/lib/month-range");

    const result = await setBudget(WALLET_ID, CATEGORY_ID, {}, budgetForm("600"));

    expect(result).toEqual({});
    expect(rpcCalls).toEqual([
      {
        fn: "set_budget",
        args: {
          p_wallet_id: WALLET_ID,
          p_category_id: CATEGORY_ID,
          p_period_start: monthRange().from,
          p_amount_minor: 60000,
        },
      },
    ]);
    // Positive control for the `expect(fromTables).toEqual([])` assertion
    // in "rejects malformed input before touching the database" below: if
    // the mock's `.from()` recorder silently stopped recording, that
    // absence check would pass vacuously (an empty array either way).
    // Asserting a real, non-empty recording on this happy path is what
    // makes the empty one elsewhere mean "this action touched no table",
    // not "nothing is being recorded".
    expect(fromTables).toEqual(["wallet_members", "wallets"]);
  });

  it("uses the wallet's own currency's minor unit, not a hardcoded 2", async () => {
    // JPY has minor unit 0 (src/lib/money.ts MINOR_UNITS). With only USD
    // fixtures elsewhere in this file, a hardcoded `2` in place of
    // `minorUnitFor(wallet.currency_code)` would leave every other test
    // green -- this is the one case that can tell the two apart. "600" in
    // a zero-decimal currency is 600 minor units, not 60000.
    walletLookup.data = { currency_code: "JPY" };

    const result = await setBudget(WALLET_ID, CATEGORY_ID, {}, budgetForm("600"));

    expect(result).toEqual({});
    expect(rpcCalls).toEqual([
      expect.objectContaining({ fn: "set_budget", args: expect.objectContaining({ p_amount_minor: 600 }) }),
    ]);
  });

  it("reports the wallet not found when the wallet lookup returns null", async () => {
    walletLookup.data = null;

    const result = await setBudget(WALLET_ID, CATEGORY_ID, {}, budgetForm("600"));

    expect(result).toEqual({ error: "Account not found." });
    expect(rpcCalls).toEqual([]);
  });

  it("passes a null category through for the overall cap", async () => {
    const result = await setBudget(WALLET_ID, null, {}, budgetForm("600"));

    expect(result).toEqual({});
    expect(rpcCalls).toEqual([
      expect.objectContaining({ fn: "set_budget", args: expect.objectContaining({ p_category_id: null }) }),
    ]);
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await setBudget(WALLET_ID, CATEGORY_ID, {}, budgetForm("600"));

    expect(result).toEqual({ error: "Not signed in" });
    expect(rpcCalls).toEqual([]);
  });

  it("rejects malformed input before touching the database", async () => {
    const result = await setBudget(WALLET_ID, CATEGORY_ID, {}, budgetForm("six hundred"));

    expect(result).toEqual({ error: "Enter an amount like 600 or 600.50" });
    expect(fromTables).toEqual([]);
  });

  it("rejects a malformed walletId with the same no-access message a real-but-inaccessible one gets", async () => {
    const result = await setBudget("not-a-uuid", CATEGORY_ID, {}, budgetForm("600"));

    expect(result).toEqual({ error: "You do not have access to that account." });
    expect(fromTables).toEqual([]);
  });

  it("rejects a malformed categoryId before touching the database", async () => {
    const result = await setBudget(WALLET_ID, "not-a-uuid", {}, budgetForm("600"));

    expect(result).toEqual({ error: "Could not save that budget. Please try again." });
    expect(fromTables).toEqual([]);
  });
});

describe("removeBudget", () => {
  it("reports an error when it matches no row", async () => {
    budgetsDelete.data = [];

    const result = await removeBudget(BUDGET_ID);

    expect(result).toEqual({ error: "That budget no longer exists." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("revalidates /budgets on success", async () => {
    const result = await removeBudget(BUDGET_ID);

    expect(result).toEqual({});
    expect(revalidatePath).toHaveBeenCalledWith("/budgets");
    // Positive control for the `expect(budgetsEqCalls).toEqual([])`
    // assertion in "returns an error when there is no session" below —
    // same reasoning as the fromTables positive control above: a silently
    // non-recording mock would make that absence check pass vacuously.
    expect(budgetsEqCalls).toEqual([["eq", "id", BUDGET_ID]]);
  });

  it("returns an error, never throws, when the delete fails", async () => {
    budgetsDelete.error = { message: "connection reset", code: "08006" };

    const result = await removeBudget(BUDGET_ID);

    expect(result).toEqual({ error: "Could not remove that budget. Please try again." });
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await removeBudget(BUDGET_ID);

    expect(result).toEqual({ error: "Not signed in" });
    expect(budgetsEqCalls).toEqual([]);
  });

  it("rejects a malformed id with the same not-found message a real-but-inaccessible one gets", async () => {
    const result = await removeBudget("not-a-uuid");

    expect(result).toEqual({ error: "That budget no longer exists." });
    expect(budgetsEqCalls).toEqual([]);
  });
});
