import { describe, it, expect, vi, beforeEach } from "vitest";

const EXPENSE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WALLET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SPACE_ID = "88888888-8888-4888-8888-888888888888";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/**
 * A table-keyed fake: each `.from(table)` chain resolves to `results[table]`
 * for reads and `insertResult` for the insert. createRefund reads the
 * expense (transactions), then the wallet (wallets), then inserts.
 */
const { results, insertSpy, insertResult, revalidatePath } = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: unknown }>,
  insertSpy: vi.fn(),
  insertResult: { data: { id: "new-id" } as unknown, error: null as unknown },
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
    from: (table: string) => {
      let inserting = false;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) b[m] = () => b;
      b.insert = (payload: unknown) => {
        inserting = true;
        insertSpy(payload);
        return b;
      };
      b.single = () => b;
      b.maybeSingle = () => b;
      b.then = (resolve: (v: unknown) => void) => resolve(inserting ? insertResult : results[table]);
      return b;
    },
  }),
}));

import { createRefund } from "./refunds";

const input = (over: Partial<Parameters<typeof createRefund>[0]> = {}) => ({
  refund_of: EXPENSE_ID,
  wallet_id: WALLET_ID,
  amount: "5.00",
  occurred_on: "2026-10-02",
  note: "Alice",
  merchant: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  results.transactions = { data: { id: EXPENSE_ID, kind: "expense", currency_code: "SGD", space_id: SPACE_ID }, error: null };
  results.wallets = { data: { currency_code: "SGD", archived_at: null, space_id: SPACE_ID }, error: null };
  insertResult.data = { id: "new-id" };
  insertResult.error = null;
});

describe("createRefund", () => {
  it("inserts a positive refund linked to the expense, with no category", async () => {
    expect(await createRefund(input())).toEqual({ id: "new-id" });
    expect(insertSpy).toHaveBeenCalledWith({
      wallet_id: WALLET_ID,
      space_id: SPACE_ID,
      created_by: USER_ID,
      kind: "refund",
      amount_minor: 500,
      currency_code: "SGD",
      refund_of: EXPENSE_ID,
      occurred_on: "2026-10-02",
      note: "Alice",
      merchant: null,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("refuses a missing or non-expense parent without inserting", async () => {
    results.transactions = { data: { id: EXPENSE_ID, kind: "income", currency_code: "SGD", space_id: SPACE_ID }, error: null };
    expect(await createRefund(input())).toEqual({ error: "Expense not found" });
    results.transactions = { data: null, error: null };
    expect(await createRefund(input())).toEqual({ error: "Expense not found" });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("refuses a wallet in another currency", async () => {
    results.wallets = { data: { currency_code: "USD", archived_at: null, space_id: SPACE_ID }, error: null };
    expect(await createRefund(input())).toEqual({
      error: "A repayment must be in the same currency as its expense.",
    });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("refuses an archived or invisible wallet", async () => {
    results.wallets = { data: { currency_code: "SGD", archived_at: "2026-01-01T00:00:00Z", space_id: SPACE_ID }, error: null };
    expect(await createRefund(input())).toEqual({ error: "Wallet not found" });
    results.wallets = { data: null, error: null };
    expect(await createRefund(input())).toEqual({ error: "Wallet not found" });
  });

  it("refuses a wallet in another household with its own message", async () => {
    results.wallets = {
      data: { currency_code: "SGD", archived_at: null, space_id: "99999999-9999-4999-8999-999999999999" },
      error: null,
    };
    expect(await createRefund(input())).toEqual({
      error: "A repayment must go to a wallet in the same household as its expense.",
    });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("refuses zero and over-precise amounts", async () => {
    expect(await createRefund(input({ amount: "0" }))).toEqual({ error: "Enter an amount greater than zero" });
    expect("error" in (await createRefund(input({ amount: "5.001" })))).toBe(true);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("maps a trigger error and hides any other database error", async () => {
    insertResult.data = null;
    insertResult.error = { message: "the repaid expense was deleted" };
    expect(await createRefund(input())).toEqual({ error: "The expense this repaid was deleted." });
    insertResult.error = { message: "some internal failure" };
    expect(await createRefund(input())).toEqual({ error: "Could not save repayment. Please try again." });
  });
});
