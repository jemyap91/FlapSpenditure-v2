// src/server/actions/transactions-restore.test.ts
//
// A neighbour of transactions.test.ts, not an addition to it: that file's
// own header comment explains it deliberately imports only
// src/lib/validation/transaction.ts so it never reaches
// src/lib/supabase/server.ts (which throws at import time with no
// NEXT_PUBLIC_SUPABASE_URL/ANON_KEY set — `npm test` runs with neither).
// Covering setDeletedAt/restoreTransaction's actual logic instead requires
// importing ./transactions directly, so this file follows
// src/server/actions/wallets.test.ts and budgets.test.ts's own convention:
// vi.mock both "@/lib/supabase/server" and "next/cache" before the real
// modules ever load.
//
// Fix 4 (task-2-fix-1, IMPORTANT): restoreTransaction -> setDeletedAt(id,
// null) can hit transactions_recurring_occurrence — the partial unique
// index supabase/migrations/0015_recurring.sql adds on (recurring_id,
// occurred_on) where recurring_id is not null and deleted_at is null —
// whenever a live sibling already occupies the same occurrence. Before this
// fix, setDeletedAt flattened EVERY update error (including Postgres 23505
// unique_violation) into the generic "Could not update transaction",
// leaving Undo dead with no explanation and no recovery path.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { softDeleteTransaction, restoreTransaction } from "./transactions";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TXN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/**
 * `vi.hoisted` — same reason as wallets.test.ts/budgets.test.ts: `vi.mock`
 * factories are hoisted above this file's own top-level `const`s.
 *
 * `fromSpy`/`eqSpy` (fix round 2, I3) tag EVERY `.from(table)` and
 * `.eq(col, val)` call, the identical pattern src/server/actions/
 * recurring.test.ts's own module comment describes and this file's own
 * `eq: () => builder` did NOT follow — proven live: changing
 * `transactions.ts`'s `await query.eq("id", id).select("id")` to
 * `await query.select("id")` (the UPDATE running with no WHERE at all,
 * soft-deleting/restoring EVERY transaction RLS lets the caller see) left
 * this file's 18/18 green, because the discarded `eq` arguments meant
 * nothing here could observe WHICH row (or whether any row at all) the
 * UPDATE was actually scoped to.
 */
const { getUser, readResult, countResult, updateResult, updateSpy, fromSpy, eqSpy, revalidatePath } =
  vi.hoisted(() => ({
    getUser: vi.fn(),
    // The initial `.select("transfer_id").eq("id", id).single()` read.
    readResult: { data: null as { transfer_id: string | null } | null, error: null as unknown },
    // The `expectedCount` head-count query, only reached for a transfer leg
    // (row.transfer_id truthy) — irrelevant to every test in this file, which
    // uses ordinary (non-transfer) transactions, but the builder needs SOME
    // response if it's ever hit by accident.
    countResult: { count: 1 as number | null },
    // The UPDATE ... .select("id") result.
    updateResult: { data: null as { id: string }[] | null, error: null as unknown },
    updateSpy: vi.fn(),
    fromSpy: vi.fn(),
    eqSpy: vi.fn(),
    revalidatePath: vi.fn(),
  }));

vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    from: (table: string) => {
      fromSpy(table);
      if (table !== "transactions") throw new Error(`unexpected table ${table}`);
      // Distinguishes the initial read (`.select("transfer_id")`) from the
      // UPDATE (`.update({...})`) the same way wallets.test.ts's fake
      // builder distinguishes count vs. update — by which entry method was
      // called most recently on this chain.
      let mode: "read" | "count" | "update" = "read";
      const builder: Record<string, unknown> = {
        select: (_cols: string, opts?: { head?: boolean }) => {
          if (opts?.head) mode = "count";
          return builder;
        },
        update: (payload: unknown) => {
          mode = "update";
          updateSpy(payload);
          return builder;
        },
        eq: (col: string, val: unknown) => {
          eqSpy(table, col, val);
          return builder;
        },
        single: async () => readResult,
        then: (resolve: (v: unknown) => void) => {
          if (mode === "count") return resolve(countResult);
          return resolve(updateResult);
        },
      };
      return builder;
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
  readResult.data = { transfer_id: null };
  readResult.error = null;
  countResult.count = 1;
  updateResult.data = [{ id: TXN_ID }];
  updateResult.error = null;
});

describe("restoreTransaction", () => {
  it("returns a specific, readable error on 23505 (the occurrence was recorded again)", async () => {
    updateResult.data = null;
    updateResult.error = { message: "duplicate key value violates unique constraint \"transactions_recurring_occurrence\"", code: "23505" };

    const result = await restoreTransaction(TXN_ID);

    expect(result).toEqual({
      error: "This occurrence has already been recorded again, so the deleted copy can't be restored.",
    });
    // The raw provider text must not leak — same convention every other
    // action in this file follows (see e.g. createTransfer's
    // KNOWN_TRANSFER_ERRORS comment).
    expect(JSON.stringify(result)).not.toContain("unique constraint");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("still returns the generic message for a non-23505 update failure", async () => {
    updateResult.data = null;
    updateResult.error = { message: "connection reset", code: "08006" };

    const result = await restoreTransaction(TXN_ID);

    expect(result).toEqual({ error: "Could not update transaction" });
  });

  it("succeeds and revalidates when the UPDATE has no conflict", async () => {
    const result = await restoreTransaction(TXN_ID);

    expect(result).toEqual({ ok: true });
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: null }));
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await restoreTransaction(TXN_ID);

    expect(result).toEqual({ error: "Not signed in" });
  });

  /**
   * Fix round 2, I3: proven live — `transactions.ts`'s
   * `await query.eq("id", id).select("id")` changed to
   * `await query.select("id")` (dropping the UPDATE's own WHERE clause
   * entirely, for a non-transfer row) left this file's 18/18 green before
   * `eqSpy` existed. `setDeletedAt` calls `.eq("id", id)` on `transactions`
   * TWICE for a non-transfer row in this flow — once for the initial
   * `.select("transfer_id")` lookup, once for the UPDATE itself — so the
   * mutation is caught by the count dropping from two to one, not merely by
   * the call having happened at all (which the lookup alone would already
   * satisfy).
   */
  it("scopes both the initial lookup and the UPDATE itself to this transaction's id", async () => {
    await restoreTransaction(TXN_ID);

    expect(fromSpy).toHaveBeenCalledWith("transactions");
    const idFilterCalls = eqSpy.mock.calls.filter(
      ([table, col, val]) => table === "transactions" && col === "id" && val === TXN_ID,
    );
    expect(idFilterCalls).toHaveLength(2);
  });
});

describe("softDeleteTransaction", () => {
  // Positive control, paired with restoreTransaction's 23505 test above:
  // proves that branch is reachable ONLY on restore, not on delete — a
  // soft DELETE always transitions deleted_at OUT of
  // transactions_recurring_occurrence's partial predicate, so it can never
  // collide with that index. If a future change made softDeleteTransaction
  // hit the same 23505 branch, this test would still pass (23505 maps to
  // the same specific message either way) — it exists to document the
  // asymmetry, and the ordinary-failure test below is what actually pins
  // softDeleteTransaction's ordinary error path.
  it("still returns the generic message for a non-23505 update failure", async () => {
    updateResult.data = null;
    updateResult.error = { message: "connection reset", code: "08006" };

    const result = await softDeleteTransaction(TXN_ID);

    expect(result).toEqual({ error: "Could not update transaction" });
  });

  it("succeeds and revalidates", async () => {
    const result = await softDeleteTransaction(TXN_ID);

    expect(result).toEqual({ ok: true });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.any(String) }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  // Same coverage gap as restoreTransaction's identical test above, on the
  // delete side of the same shared `setDeletedAt` implementation.
  it("scopes both the initial lookup and the UPDATE itself to this transaction's id", async () => {
    await softDeleteTransaction(TXN_ID);

    const idFilterCalls = eqSpy.mock.calls.filter(
      ([table, col, val]) => table === "transactions" && col === "id" && val === TXN_ID,
    );
    expect(idFilterCalls).toHaveLength(2);
  });
});
