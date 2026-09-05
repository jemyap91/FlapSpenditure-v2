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
const WALLET_ID_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WALLET_ID_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CATEGORY_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BUDGET_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

/**
 * `vi.hoisted` is required because `vi.mock` factories are hoisted above
 * this file's own top-level `const`s (same note as invites.test.ts).
 */
const {
  getUser,
  membershipRows,
  walletLookup,
  budgetsDelete,
  budgetsEqCalls,
  rpcResult,
  rpcCalls,
  fromTables,
  revalidatePath,
} = vi.hoisted(() => ({
  getUser: vi.fn(),
  membershipRows: [] as { wallet_id: string }[],
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
          in: () => ({ then: (resolve: (v: { data: typeof membershipRows; error: null }) => void) =>
            resolve({ data: membershipRows, error: null }) }),
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

const budgetForm = (amount: string, walletIds: string[]) => {
  const fd = new FormData();
  fd.set("amount", amount);
  for (const id of walletIds) fd.append("walletIds", id);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  budgetsEqCalls.length = 0;
  rpcCalls.length = 0;
  fromTables.length = 0;
  membershipRows.length = 0;
  membershipRows.push({ wallet_id: WALLET_ID_1 }, { wallet_id: WALLET_ID_2 });
  walletLookup.data = { currency_code: "USD" };
  walletLookup.error = null;
  budgetsDelete.data = [{ id: BUDGET_ID }];
  budgetsDelete.error = null;
  rpcResult.error = null;
  getUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
});

describe("setBudget", () => {
  it("refuses an empty wallet set before any RPC or table lookup", async () => {
    const result = await setBudget(CATEGORY_ID, {}, budgetForm("600", []));

    expect(result).toEqual({ error: "Choose at least one wallet" });
    expect(rpcCalls).toEqual([]);
    expect(fromTables).toEqual([]);
  });

  it("rejects a malformed wallet id before touching the database", async () => {
    // budgetInput validates each wallet id as z.uuid() (src/lib/validation/
    // budget.ts) — this must be refused by the schema itself, before any
    // Supabase client is constructed, not left to surface later as a
    // generic "could not save" from set_budget's own uuid[] cast.
    const result = await setBudget(CATEGORY_ID, {}, budgetForm("600", ["not-a-uuid"]));

    expect(result).toEqual({ error: "Invalid UUID" });
    expect(rpcCalls).toEqual([]);
    expect(fromTables).toEqual([]);
  });

  it("rejects a blank categoryId before touching the database (N3)", async () => {
    // Never reachable through the real UI (AddBudgetForm's own translation
    // sends an explicit `null` for the overall cap, never `""`), but this
    // is a bound Server Function argument, reachable via direct POST with
    // any string — same reasoning as `idSchema`'s own doc comment above.
    const result = await setBudget("", {}, budgetForm("600", [WALLET_ID_1]));

    expect(result).toEqual({ error: "That category is not valid." });
    expect(rpcCalls).toEqual([]);
    expect(fromTables).toEqual([]);
  });

  it("rejects a categoryId that is not a uuid before touching the database (N3, 0023)", async () => {
    // A category NAME — what this argument used to carry before 0023 made
    // it a real id — must now be refused outright rather than sent on.
    const result = await setBudget("groceries", {}, budgetForm("600", [WALLET_ID_1]));

    expect(result).toEqual({ error: "That category is not valid." });
    expect(rpcCalls).toEqual([]);
  });

  it("still accepts an explicit null categoryId — the overall cap (N3)", async () => {
    const result = await setBudget(null, {}, budgetForm("600", [WALLET_ID_1]));

    expect(result).toEqual({ notice: "Budget saved." });
    expect(rpcCalls).toEqual([{ fn: "set_budget", args: expect.objectContaining({ p_category_id: null }) }]);
  });

  it("refuses a non-member set with a readable message", async () => {
    membershipRows.length = 0;
    membershipRows.push({ wallet_id: WALLET_ID_1 }); // caller is not in WALLET_ID_2

    const result = await setBudget(CATEGORY_ID, {}, budgetForm("600", [WALLET_ID_1, WALLET_ID_2]));

    expect(result).toEqual({ error: "You do not have access to one or more of those wallets." });
    expect(rpcCalls).toEqual([]);
  });

  it("returns an error, never throws, when set_budget is refused", async () => {
    rpcResult.error = { message: "not a member of every account in that set" };

    const result = await setBudget(CATEGORY_ID, {}, budgetForm("600", [WALLET_ID_1, WALLET_ID_2]));

    // App-authored text. The raw provider string above is set_budget's own
    // internal message; forwarding it is the leak this codebase's
    // convention exists to prevent.
    expect(result).toEqual({ error: "Could not save that budget. Please try again." });
    expect(JSON.stringify(result)).not.toContain("member of every account");
  });

  it("rejects a zero amount", async () => {
    const result = await setBudget(CATEGORY_ID, {}, budgetForm("0", [WALLET_ID_1]));

    expect(result).toEqual({ error: "Enter an amount greater than zero." });
    expect(rpcCalls).toEqual([]);
  });

  it("calls set_budget with the first of the current month and the exact flat wallet array", async () => {
    const { monthRange } = await import("@/lib/month-range");

    const result = await setBudget(CATEGORY_ID, {}, budgetForm("600", [WALLET_ID_1, WALLET_ID_2]));

    expect(result).toEqual({ notice: "Budget saved." });
    expect(rpcCalls).toEqual([
      {
        fn: "set_budget",
        args: {
          p_category_id: CATEGORY_ID,
          p_period_start: monthRange().from,
          p_amount_minor: 60000,
          p_wallet_ids: [WALLET_ID_1, WALLET_ID_2],
        },
      },
    ]);
    // The array must be FLAT, not nested — a nested array (`{{w1,w2}}`)
    // once defeated set_budget's own membership guard at the SQL layer,
    // because `array_length(x, 1)` counts only the first dimension while
    // `unnest` counts every element (0013's C1 finding, closed in SQL).
    // This asserts the JS side never reintroduces that shape: the array
    // reaching the RPC must be the EXACT SAME shape `formData.getAll()`
    // produced — same length, same elements, same order, no element
    // itself an array.
    const sentArgs = rpcCalls[0]!.args as { p_wallet_ids: unknown };
    const expectedFlat = budgetForm("600", [WALLET_ID_1, WALLET_ID_2]).getAll("walletIds");
    expect(sentArgs.p_wallet_ids).toEqual(expectedFlat);
    expect(Array.isArray(sentArgs.p_wallet_ids)).toBe(true);
    expect((sentArgs.p_wallet_ids as unknown[]).every((v) => typeof v === "string")).toBe(true);
    expect((sentArgs.p_wallet_ids as unknown[]).some((v) => Array.isArray(v))).toBe(false);
  });

  it("uses the wallet's own currency's minor unit, not a hardcoded 2", async () => {
    // JPY has minor unit 0 (src/lib/money.ts MINOR_UNITS). With only USD
    // fixtures elsewhere in this file, a hardcoded `2` in place of
    // `minorUnitFor(wallet.currency_code)` would leave every other test
    // green -- this is the one case that can tell the two apart. "600" in
    // a zero-decimal currency is 600 minor units, not 60000.
    walletLookup.data = { currency_code: "JPY" };

    const result = await setBudget(CATEGORY_ID, {}, budgetForm("600", [WALLET_ID_1]));

    expect(result).toEqual({ notice: "Budget saved." });
    expect(rpcCalls).toEqual([
      expect.objectContaining({ fn: "set_budget", args: expect.objectContaining({ p_amount_minor: 600 }) }),
    ]);
  });

  it("reports the wallet not found when the wallet lookup returns null", async () => {
    walletLookup.data = null;

    const result = await setBudget(CATEGORY_ID, {}, budgetForm("600", [WALLET_ID_1]));

    expect(result).toEqual({ error: "Wallet not found." });
    expect(rpcCalls).toEqual([]);
  });

  it("passes a null category id through as a real null for the overall cap", async () => {
    const result = await setBudget(null, {}, budgetForm("600", [WALLET_ID_1]));

    expect(result).toEqual({ notice: "Budget saved." });
    expect(rpcCalls).toEqual([
      expect.objectContaining({ fn: "set_budget", args: expect.objectContaining({ p_category_id: null }) }),
    ]);
    // Not `undefined`, not `""` — an explicit `null` reaches the RPC. The
    // args object must actually contain the key with value null, not omit
    // it (which JSON.stringify would render identically to `undefined`).
    const sentArgs = rpcCalls[0]!.args as Record<string, unknown>;
    expect("p_category_id" in sentArgs).toBe(true);
    expect(sentArgs.p_category_id).toBeNull();
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await setBudget(CATEGORY_ID, {}, budgetForm("600", [WALLET_ID_1]));

    expect(result).toEqual({ error: "Not signed in" });
    expect(rpcCalls).toEqual([]);
  });

  it("rejects malformed input before touching the database", async () => {
    const result = await setBudget(CATEGORY_ID, {}, budgetForm("six hundred", [WALLET_ID_1]));

    expect(result).toEqual({ error: "Enter an amount like 600 or 600.50" });
    expect(fromTables).toEqual([]);
  });

  it("revalidates both /budgets and / on success", async () => {
    await setBudget(CATEGORY_ID, {}, budgetForm("600", [WALLET_ID_1]));

    expect(revalidatePath).toHaveBeenCalledWith("/budgets");
    expect(revalidatePath).toHaveBeenCalledWith("/");
    // N7d (whole-branch review): positive control for the four
    // `expect(fromTables).toEqual([])` assertions above (each proving a
    // guard runs BEFORE any Supabase client is touched — one of the four is
    // N3's own blank-categoryId test, added after N7d's original count).
    // Without this, a mock that silently stopped recording table names
    // would make every one of those absence checks pass vacuously forever,
    // the same class of gap `budgetsEqCalls`'s own positive control below
    // (in `removeBudget`) already closes.
    expect(fromTables).toEqual(["wallet_members", "wallets"]);
  });
});

describe("removeBudget", () => {
  it("reports an error when it matches no row", async () => {
    budgetsDelete.data = [];

    const result = await removeBudget(BUDGET_ID);

    expect(result).toEqual({ error: "That budget no longer exists." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("revalidates both /budgets and / on success", async () => {
    const result = await removeBudget(BUDGET_ID);

    expect(result).toEqual({});
    expect(revalidatePath).toHaveBeenCalledWith("/budgets");
    expect(revalidatePath).toHaveBeenCalledWith("/");
    // Positive control for the `expect(budgetsEqCalls).toEqual([])`
    // assertion in "returns an error when there is no session" below —
    // a silently non-recording mock would make that absence check pass
    // vacuously.
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
