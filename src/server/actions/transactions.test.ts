import { describe, it, expect, vi, beforeEach } from "vitest";
// signedAmount/precisionError are imported from src/lib/validation/
// transaction.ts, not "./transactions" — signedAmount moved there so it can
// stay a plain synchronous function; transactions.ts carries a file-level
// "use server" directive (required so createTransaction/updateTransaction/
// createTransfer/softDeleteTransaction/restoreTransaction are importable
// from a Client Component — Task 19/20), and per node_modules/next/dist/
// docs/01-app/03-api-reference/01-directives/use-server.md every export from
// such a file must be an `async function`; a plain synchronous helper
// cannot live there.
//
// `updateTransaction` itself IS imported from "./transactions" below, which
// does reach `@/lib/supabase/server` (-> `next/headers` / `server-only`) at
// module-evaluation time. `npm test` runs with no `.env.local`, so without
// intervention that import would throw before this file's tests could even
// register. `vi.mock` below intercepts `@/lib/supabase/server` before
// `./transactions` loads — the same technique src/server/actions/
// {wallets,recurring}.test.ts use — so this suite exercises
// `updateTransaction`'s real logic against a fake client rather than a
// stand-in for the action itself.
import { signedAmount, precisionError } from "@/lib/validation/transaction";
import { updateTransaction } from "./transactions";

const TXN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WALLET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CATEGORY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/**
 * `vi.hoisted` because `vi.mock` factories are hoisted above this file's own
 * top-level `const`s (recurring.test.ts's identical note).
 *
 * `fromSpy`/`eqSpy` tag EVERY `.from(table)` and `.eq(col, val)` call with
 * the table it happened on — recurring.test.ts's module comment explains why
 * this is load-bearing rather than decorative: a shared, table-blind
 * `eq: () => builder` cannot tell "the UPDATE was scoped to this row's id"
 * apart from "an .eq call happened somewhere, on some table, with some
 * column." This suite follows that exact convention rather than inventing a
 * second one — `updateTransaction`'s own scoping test below only means
 * anything because `eqSpy` can be asked which table and column a call
 * actually landed on.
 *
 * `isSpy` (fix round 1, "decide and state" item) is the identical pattern
 * applied to `.is(col, val)` — the method `updateTransaction`'s
 * `deleted_at is null` filters use, since `.eq` can't express "IS NULL".
 * Without it, tagging `.is("deleted_at", null)` calls in production would be
 * unobservable to any test the same way an untagged `.eq` was before
 * `eqSpy` existed.
 */
const {
  getUser,
  txnLookupResult,
  walletLookupResult,
  categoryResult,
  updateResult,
  updateSpy,
  fromSpy,
  eqSpy,
  isSpy,
  revalidatePath,
} = vi.hoisted(() => ({
  getUser: vi.fn(),
  // Shared by updateTransaction's initial `.select("wallet_id, kind")`
  // lookup — the row it's told to report editing.
  txnLookupResult: { data: null as { wallet_id: string; kind: string } | null },
  walletLookupResult: {
    data: null as { archived_at: string | null; currency_code: string } | null,
  },
  categoryResult: { data: null as { kind: string; archived_at: string | null } | null },
  updateResult: { data: null as { id: string }[] | null, error: null as unknown },
  updateSpy: vi.fn(),
  fromSpy: vi.fn(),
  eqSpy: vi.fn(),
  isSpy: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    from: (table: string) => {
      fromSpy(table);
      if (table === "wallets") {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (col: string, val: unknown) => {
            eqSpy(table, col, val);
            return builder;
          },
          single: () => builder,
          then: (resolve: (v: unknown) => void) => resolve(walletLookupResult),
        };
        return builder;
      }
      if (table === "categories") {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (col: string, val: unknown) => {
            eqSpy(table, col, val);
            return builder;
          },
          single: () => builder,
          then: (resolve: (v: unknown) => void) => resolve(categoryResult),
        };
        return builder;
      }
      if (table !== "transactions") {
        throw new Error(`unexpected table ${table}`);
      }
      // One builder covers both of updateTransaction's `transactions`
      // calls — the initial SELECT lookup (mode stays "lookup") and the
      // UPDATE (mode switches once `.update(...)` is called) — the same
      // mode-switching shape recurring.test.ts's shared builder uses.
      let mode: "lookup" | "update" = "lookup";
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (payload: unknown) => {
          mode = "update";
          updateSpy(payload);
          return builder;
        },
        eq: (col: string, val: unknown) => {
          eqSpy(table, col, val);
          return builder;
        },
        is: (col: string, val: unknown) => {
          isSpy(table, col, val);
          return builder;
        },
        single: () => builder,
        then: (resolve: (v: unknown) => void) =>
          resolve(mode === "update" ? updateResult : txnLookupResult),
      };
      return builder;
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } } });
  txnLookupResult.data = { wallet_id: WALLET_ID, kind: "expense" };
  walletLookupResult.data = { archived_at: null, currency_code: "SGD" };
  categoryResult.data = { kind: "expense", archived_at: null };
  updateResult.data = [{ id: TXN_ID }];
  updateResult.error = null;
});

function edit(
  overrides: Partial<{
    id: string;
    amount: string;
    occurred_on: string;
    category_id: string | null;
    note: string | null;
    merchant: string | null;
  }> = {},
) {
  return {
    id: TXN_ID,
    amount: "42.50",
    occurred_on: "2026-07-01",
    category_id: CATEGORY_ID,
    note: null,
    merchant: null,
    ...overrides,
  };
}

describe("signedAmount", () => {
  it("makes an expense negative", () => {
    expect(signedAmount("expense", 1250)).toBe(-1250);
  });

  it("makes an income positive", () => {
    expect(signedAmount("income", 1250)).toBe(1250);
  });

  it("accepts the smallest positive boundary — 1 minor unit", () => {
    expect(signedAmount("expense", 1)).toBe(-1);
    expect(signedAmount("income", 1)).toBe(1);
  });

  it("accepts a large boundary value (Number.MAX_SAFE_INTEGER)", () => {
    expect(signedAmount("income", Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(signedAmount("expense", Number.MAX_SAFE_INTEGER)).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it("rejects a zero magnitude for both expense and income", () => {
    expect(() => signedAmount("expense", 0)).toThrow();
    expect(() => signedAmount("income", 0)).toThrow();
  });

  it("rejects a negative magnitude — sign comes from kind, never input", () => {
    expect(() => signedAmount("expense", -5)).toThrow();
    expect(() => signedAmount("income", -5)).toThrow();
  });

  it("rejects a non-integer magnitude", () => {
    expect(() => signedAmount("expense", 12.5)).toThrow();
    expect(() => signedAmount("income", 12.5)).toThrow();
  });

  it("rejects a value past Number.MAX_SAFE_INTEGER, even though it's Number.isInteger-true", () => {
    // Number.isInteger(2 ** 53 + 2) === true, despite that value having
    // already lost precision — Number.isSafeInteger is the correct guard
    // for this, the app's single sign gate, and this is the test that
    // would have failed under the old Number.isInteger check.
    const unsafe = 2 ** 53 + 2;
    expect(Number.isInteger(unsafe)).toBe(true);
    expect(Number.isSafeInteger(unsafe)).toBe(false);
    expect(() => signedAmount("expense", unsafe)).toThrow();
    expect(() => signedAmount("income", unsafe)).toThrow();
  });

  it("rejects kind 'transfer' — transfer legs are signed by create_transfer, not this helper", () => {
    expect(() => signedAmount("transfer", 1250)).toThrow();
    // Even a well-formed positive magnitude doesn't make "transfer" valid
    // here — the rejection is about the kind, not the amount.
    expect(() => signedAmount("transfer", 1)).toThrow();
  });
});

describe("precisionError (src/lib/validation/transaction.ts)", () => {
  it("flags a fraction longer than the currency's minor unit", () => {
    expect(precisionError("12.999", 0, "JPY")).toMatch(/JPY/);
    expect(precisionError("10.005", 2, "USD")).toMatch(/USD/);
    expect(precisionError("12.3456", 3, "KWD")).toMatch(/KWD/);
  });

  it("accepts an amount within the currency's precision", () => {
    expect(precisionError("1500", 0, "JPY")).toBeUndefined();
    expect(precisionError("10.00", 2, "USD")).toBeUndefined();
    expect(precisionError("12.345", 3, "KWD")).toBeUndefined();
  });

  it("leaves a malformed amount for parseAmountInput's own rejection", () => {
    expect(precisionError("12.34.56", 2, "USD")).toBeUndefined();
  });
});

describe("updateTransaction", () => {
  it("never writes wallet_id, kind, or recurring_occurrence_on", async () => {
    // The grant excludes all three. wallet_id would let a member of two
    // wallets move a row out of one (0004_rls.sql:83's own reasoning);
    // recurring_occurrence_on is an occurrence's identity, not user data.
    await updateTransaction(edit());

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = updateSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("wallet_id");
    expect(payload).not.toHaveProperty("kind");
    expect(payload).not.toHaveProperty("recurring_occurrence_on");
  });

  /**
   * The brief this task was written from asserted this with a bare
   * `expect(eqSpy).toHaveBeenCalledWith("id", TXN_ID)` — a call shape this
   * suite's `eqSpy` never produces (it's always `(table, col, val)`, per the
   * module comment above), and even adapted to three arguments that
   * assertion alone would NOT discriminate step 5's mutation: the initial
   * `.select("wallet_id, kind").eq("id", id)` lookup already calls
   * `eqSpy("transactions", "id", TXN_ID)` once, before the UPDATE is ever
   * built, so `toHaveBeenCalledWith` stays true even with the UPDATE's own
   * `.eq("id", id)` deleted. Counting the calls (mirroring recurring.test.ts's
   * "scopes both the initial lookup and the UPDATE itself to this rule's id")
   * is what actually proves the UPDATE itself carries the filter — the count
   * drops from two to one when it's removed. See task-3-report.md for the
   * before/after output this test's design is proven against.
   */
  it("scopes both the initial lookup and the UPDATE itself to the row's own id", async () => {
    await updateTransaction(edit());

    const idCalls = eqSpy.mock.calls.filter(
      ([table, col, val]) => table === "transactions" && col === "id" && val === TXN_ID,
    );
    expect(idCalls).toHaveLength(2);
  });

  /**
   * Fix round 1, "decide and state": a soft-deleted transaction was
   * editable by direct POST — neither the lookup nor the UPDATE excluded
   * `deleted_at is not null` rows. Decided to filter both (see the doc
   * comment on the lookup in transactions.ts), rather than leave it as an
   * unstated asymmetry with `setDeletedAt`'s restore/delete pair: editing a
   * deleted transaction is treated as "not found," the same way editing one
   * from another wallet is. Both call sites are asserted, the same
   * count-based shape as the id-scoping test above, for the same reason —
   * `.is("deleted_at", null)` appearing ANYWHERE would satisfy a bare
   * `toHaveBeenCalledWith`, but only a count of 2 proves both the lookup
   * AND the UPDATE carry it.
   */
  it("excludes a soft-deleted row from both the lookup and the UPDATE", async () => {
    await updateTransaction(edit());

    const deletedAtCalls = isSpy.mock.calls.filter(
      ([table, col, val]) => table === "transactions" && col === "deleted_at" && val === null,
    );
    expect(deletedAtCalls).toHaveLength(2);
  });

  it("refuses an archived wallet", async () => {
    walletLookupResult.data = { archived_at: "2026-06-01T00:00:00Z", currency_code: "SGD" };

    const result = await updateTransaction(edit());

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/archived/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("refuses a category whose kind does not match", async () => {
    categoryResult.data = { kind: "income", archived_at: null };

    const result = await updateTransaction(edit());

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/doesn't match/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1, IMPORTANT 1: unasserted before this — deleting
   * `.eq("wallet_id", wallet_id)` from the category lookup (transactions.ts)
   * left all 30 tests green. `createTransaction`'s own comment on the
   * identical filter explains what's actually at stake: without it, a
   * category id from a DIFFERENT wallet that happens to satisfy the kind
   * check reaches the UPDATE and dies on the composite FK
   * `transactions_category_same_wallet`, surfacing as the generic "Could
   * not save transaction. Please try again." instead of this readable
   * validation error. Mirrors recurring.test.ts's "scopes the category
   * lookup to the rule's own wallet_id" test.
   */
  it("scopes the category lookup to the transaction's own wallet_id", async () => {
    await updateTransaction(edit());

    expect(eqSpy).toHaveBeenCalledWith("categories", "wallet_id", WALLET_ID);
  });

  /**
   * Fix round 1, IMPORTANT 2: unasserted before this — deleting
   * `if (!category || category.archived_at) return { error: "Choose a
   * category" };` (transactions.ts) also left all 30 tests green. That line
   * is not just the archived-category rejection the brief named; it is
   * ALSO the null guard protecting `category.kind` on the very next line —
   * removing it turns a missing category into an uncaught TypeError
   * (`Cannot read properties of null`), the exact never-throw violation the
   * transfer guard above exists to prevent. Both branches of that `||` — a
   * category that can't be found at all, and one that's archived — are
   * covered here, both expecting the same "Choose a category" message
   * `createTransaction` uses for the identical situation.
   */
  it("rejects when the category lookup finds nothing", async () => {
    categoryResult.data = null;

    const result = await updateTransaction(edit());

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/choose a category/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rejects an archived category, even if its kind matches", async () => {
    categoryResult.data = { kind: "expense", archived_at: "2026-01-01T00:00:00Z" };

    const result = await updateTransaction(edit());

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/choose a category/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("reports not found rather than success when the UPDATE matches no row", async () => {
    updateResult.data = [];

    expect(await updateTransaction(edit())).toEqual({ error: "Transaction not found" });
  });

  it("returns Transaction not found when the row can't be looked up (RLS or a bad id)", async () => {
    txnLookupResult.data = null;

    const result = await updateTransaction(edit());

    expect(result).toEqual({ error: "Transaction not found" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await updateTransaction(edit());

    expect(result).toEqual({ error: "Not signed in" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("returns Wallet not found when the wallet lookup itself fails", async () => {
    walletLookupResult.data = null;

    const result = await updateTransaction(edit());

    expect(result).toEqual({ error: "Wallet not found" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  /**
   * `kind` never appears on `transactionEditInput` — it always comes from
   * the loaded row (see `updateTransaction`'s own doc comment) — so this
   * exercises the ONLY way a transfer leg could reach this action: an id
   * that happens to belong to one. Without an explicit guard, a transfer's
   * always-null category_id would skip the category branch entirely and the
   * call would reach `signedAmount("transfer", ...)`, which throws — an
   * uncaught throw inside a Server Function is masked to an opaque digest in
   * production, not the readable `{ error }` this module promises.
   */
  it("refuses to edit a transfer leg through this action", async () => {
    txnLookupResult.data = { wallet_id: WALLET_ID, kind: "transfer" };

    const result = await updateTransaction(edit({ category_id: null }));

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toBeTruthy();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("allows clearing the category to null without a category lookup", async () => {
    const result = await updateTransaction(edit({ category_id: null }));

    expect(result).toEqual({ ok: true });
    expect(fromSpy).not.toHaveBeenCalledWith("categories");
    const payload = updateSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.category_id).toBeNull();
  });

  /**
   * Fix round 1, MINOR 3: "signs an expense negative" (formerly here) was
   * deleted — it exercised the same amount_minor sign, on the same
   * `kind: "expense"` beforeEach default, on the same code path as "writes
   * amount, occurred_on, category_id, note and merchant" below, so nothing
   * could fail one without also failing the other. This test is the only
   * one exercising `kind: "income"` and is kept for that reason.
   */
  it("signs an income positive", async () => {
    txnLookupResult.data = { wallet_id: WALLET_ID, kind: "income" };
    categoryResult.data = { kind: "income", archived_at: null };

    await updateTransaction(edit({ amount: "12.50" }));

    const payload = updateSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.amount_minor).toBe(1250);
  });

  it("writes amount, occurred_on, category_id, note and merchant from the parsed input", async () => {
    await updateTransaction(edit({ note: "  Coffee  ", merchant: "Starbucks" }));

    const payload = updateSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      amount_minor: -4250,
      category_id: CATEGORY_ID,
      occurred_on: "2026-07-01",
      note: "Coffee",
      merchant: "Starbucks",
    });
  });

  it("rejects a zero amount", async () => {
    const result = await updateTransaction(edit({ amount: "0" }));

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/greater than zero/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rejects a fraction the currency cannot hold, rather than truncating it", async () => {
    walletLookupResult.data = { archived_at: null, currency_code: "JPY" };

    const result = await updateTransaction(edit({ amount: "12.999" }));

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/no decimal places/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("returns a validation error for malformed input, never touching the database", async () => {
    const result = await updateTransaction(edit({ amount: "" }));

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toBeTruthy();
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("returns an error, never throws, when the UPDATE itself fails", async () => {
    updateResult.data = null;
    updateResult.error = { message: "boom", code: "XX000" };

    const result = await updateTransaction(edit());

    expect(result).toEqual({ error: "Could not save transaction. Please try again." });
  });

  it("revalidates the layout on success", async () => {
    await updateTransaction(edit());

    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});
