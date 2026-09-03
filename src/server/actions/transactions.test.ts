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
import { createTransaction, updateTransaction, updateTransfer } from "./transactions";

const TXN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WALLET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CATEGORY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TRANSFER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
// A transfer's two legs live in two DIFFERENT wallets — `WALLET_ID` is the
// outgoing leg's, `WALLET_IN_ID` the incoming leg's. Distinct ids (task 8,
// item 3) so a check written against only one leg's wallet is visible:
// with one shared id, "checks the out leg" and "checks both" are the same
// test.
const WALLET_IN_ID = "99999999-9999-4999-8999-999999999999";
// The category the row being edited ALREADY carries, deliberately distinct
// from CATEGORY_ID (what `edit()` posts by default). Fix round 1, IMPORTANT
// 1: `updateTransaction` now exempts an UNCHANGED archived category from the
// archived check, so "the posted category" and "the row's current category"
// stopped being interchangeable and this suite can no longer use one id for
// both without making that exemption untestable.
const ROW_CATEGORY_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

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
 *
 * `legsLookupResult` and `rpcSpy` back `updateTransfer` (Task 4).
 * `legsLookupResult` is what the shared "transactions" builder resolves to
 * for a `.select(...)` that never calls `.single()` — `updateTransfer`'s
 * pre-flight `.eq("transfer_id", ...).is("deleted_at", null)` lookup, which
 * expects an ARRAY of (up to) two legs back, unlike `updateTransaction`'s
 * single-row `txnLookupResult`. The builder tells the two apart by whether
 * `.single()` was called on this chain (`usedSingle`, inside the `from`
 * factory below) — `updateTransaction` always calls it, `updateTransfer`'s
 * pre-flight lookup never does, since a transfer is always exactly two
 * rows and there is nothing to disambiguate with `.single()`.
 * `rpcSpy` tags every `supabase.rpc(name, args)` call — `updateTransfer`
 * writes through `update_transfer_pair` (0016_editable_transactions.sql),
 * not through `.from("transactions").update(...)`, so `updateSpy` (which
 * only fires on that method) never sees it; `rpcSpy` is the equivalent
 * instrumentation for the RPC path, and `updateResult` (already declared
 * for `updateTransaction`) doubles as the RPC's canned return value, since
 * both are "the write operation's result rows."
 */
const {
  getUser,
  txnLookupResult,
  walletLookupResult,
  categoryResult,
  legsLookupResult,
  legWalletsResult,
  inSpy,
  insertResult,
  insertSpy,
  updateResult,
  updateSpy,
  rpcSpy,
  fromSpy,
  eqSpy,
  isSpy,
  revalidatePath,
} = vi.hoisted(() => ({
  getUser: vi.fn(),
  // Shared by updateTransaction's initial
  // `.select("wallet_id, kind, category_id")` lookup — the row it's told to
  // report editing. `category_id` is the row's CURRENT category (fix round
  // 1, IMPORTANT 1), which is what the archived-category exemption is keyed
  // on; it is never what the edit posts.
  txnLookupResult: {
    data: null as {
      wallet_id: string;
      kind: string;
      category_id: string | null;
      // Both added by 0020_transaction_wallet_move.sql's edit path: the
      // transaction's own currency (so a move to a different-currency wallet
      // can be refused with a sentence instead of an FK violation) and
      // whether it is a recorded recurring occurrence (whose rule lives in
      // the current wallet and does not move).
      currency_code?: string;
      recurring_id?: string | null;
    } | null,
  },
  walletLookupResult: {
    data: null as { archived_at: string | null; currency_code: string } | null,
  },
  categoryResult: { data: null as { kind: string; archived_at: string | null } | null },
  // updateTransfer's pre-flight lookup — the transfer's own legs, keyed by
  // transfer_id rather than id, so an array rather than txnLookupResult's
  // single object. amount_minor's sign is what tells the outgoing leg from
  // the incoming one (fix round 1: each leg is now parsed against its OWN
  // currency, since amount_out/amount_in replaced the single amount field).
  legsLookupResult: {
    data: null as { wallet_id: string; amount_minor: number; currency_code: string }[] | null,
  },
  // updateTransfer's archived-wallet check (task 8, item 3): the two legs'
  // wallets, looked up with `.in("id", [...])` rather than the `.eq(...)
  // .single()` `walletLookupResult` backs. Kept as its OWN canned result,
  // and the wallets builder below tells the two apart by whether `.in` was
  // called on the chain — the same `usedSingle` technique the transactions
  // builder already uses, for the same reason: one shared value cannot be
  // both a single object and an array.
  legWalletsResult: { data: null as { id: string; archived_at: string | null }[] | null },
  // Tags every `.in(col, vals)` call with its table, exactly as `eqSpy`/
  // `isSpy` do for `.eq`/`.is`. Without it, "the archived check looked at
  // BOTH legs' wallets" would be unobservable — a check that looked up only
  // the outgoing leg's wallet id would be indistinguishable from a correct
  // one for any test that only reads the returned error.
  inSpy: vi.fn(),
  // createTransaction's INSERT (task 8, item 1). Kept separate from
  // `updateResult` rather than shared: `createTransaction` finishes with
  // `.select("id").single()`, so it expects ONE object back, while
  // `updateTransaction`'s UPDATE expects an array of touched rows — one
  // canned value cannot be both, and `insertSpy` is what lets a test read
  // the payload that actually went on the wire (the `merchant` column has
  // no other observable at this layer).
  insertResult: { data: null as { id: string } | null, error: null as unknown },
  insertSpy: vi.fn(),
  // Shared by updateTransaction's UPDATE and updateTransfer's RPC call —
  // both represent "the rows the write actually touched."
  updateResult: { data: null as { id: string; amount_minor?: number }[] | null, error: null as unknown },
  updateSpy: vi.fn(),
  rpcSpy: vi.fn(),
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
        // Whether `.in(...)` was used on THIS chain distinguishes
        // updateTransfer's two-leg archived-wallet lookup (task 8, item 3)
        // from updateTransaction/createTransaction's single-wallet
        // `.eq(...).single()` — an array result vs one object, so one canned
        // value cannot serve both.
        let usedIn = false;
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (col: string, val: unknown) => {
            eqSpy(table, col, val);
            return builder;
          },
          in: (col: string, vals: unknown) => {
            inSpy(table, col, vals);
            usedIn = true;
            return builder;
          },
          single: () => builder,
          then: (resolve: (v: unknown) => void) =>
            resolve(usedIn ? legWalletsResult : walletLookupResult),
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
      // One builder covers every `transactions`-table call from both
      // updateTransaction and updateTransfer — the initial SELECT lookup
      // (mode stays "lookup"), updateTransaction's own UPDATE (mode
      // switches once `.update(...)` is called), and updateTransfer's
      // pre-flight legs lookup (also "lookup", but resolved to
      // legsLookupResult instead of txnLookupResult — see `usedSingle`
      // below) — the same mode-switching shape recurring.test.ts's shared
      // builder uses.
      let mode: "lookup" | "insert" | "update" = "lookup";
      // Whether `.single()` was called on THIS chain — updateTransaction's
      // lookup always calls it (one row, by id); updateTransfer's pre-flight
      // lookup never does (up to two rows, by transfer_id). This is what
      // lets one shared builder resolve to the right canned result for
      // either caller without the mock needing to parse which column an
      // `.eq`/`.is` call named.
      let usedSingle = false;
      const builder: Record<string, unknown> = {
        select: () => builder,
        insert: (payload: unknown) => {
          mode = "insert";
          insertSpy(payload);
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
        is: (col: string, val: unknown) => {
          isSpy(table, col, val);
          return builder;
        },
        single: () => {
          usedSingle = true;
          return builder;
        },
        then: (resolve: (v: unknown) => void) =>
          resolve(
            mode === "update"
              ? updateResult
              : mode === "insert"
                ? insertResult
                : usedSingle
                  ? txnLookupResult
                  : legsLookupResult,
          ),
      };
      return builder;
    },
    // updateTransfer writes through the update_transfer_pair RPC
    // (0016_editable_transactions.sql), not `.from("transactions").update(...)`
    // — PostgREST/the supabase-js client has no way to express the CASE that
    // preserves each leg's own sign in one client-side `.update()` call, and
    // two separate `.update()` calls are two separate, non-atomic requests
    // (see updateTransfer's own doc comment in transactions.ts for why that
    // was rejected). `updateResult` doubles as the RPC's canned return —
    // both represent "the rows the write actually touched" for whichever
    // action is under test.
    rpc: (fn: string, args: unknown) => {
      rpcSpy(fn, args);
      return Promise.resolve(updateResult);
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } } });
  // The row's own category is ROW_CATEGORY_ID, not the CATEGORY_ID `edit()`
  // posts — so by default every test below exercises the "this edit CHOOSES
  // a category" path, and a test wanting the "KEEPS its own" path has to say
  // so explicitly.
  txnLookupResult.data = { wallet_id: WALLET_ID, kind: "expense", category_id: ROW_CATEGORY_ID };
  walletLookupResult.data = { archived_at: null, currency_code: "SGD" };
  categoryResult.data = { kind: "expense", archived_at: null };
  legsLookupResult.data = [
    { wallet_id: WALLET_ID, amount_minor: -4250, currency_code: "SGD" },
    { wallet_id: WALLET_IN_ID, amount_minor: 4250, currency_code: "SGD" },
  ];
  // Both legs' wallets active by default, so the archived cases below have
  // to opt in — the same discipline the txn/category fixtures follow.
  legWalletsResult.data = [
    { id: WALLET_ID, archived_at: null },
    { id: WALLET_IN_ID, archived_at: null },
  ];
  updateResult.data = [{ id: TXN_ID }];
  updateResult.error = null;
  insertResult.data = { id: TXN_ID };
  insertResult.error = null;
});

/**
 * Task 8, item 1: what `createTransaction` puts on the wire. Added now
 * because `merchant` joined `transactionInput` — until this round the create
 * schemas had no merchant field at all, so the column could only be filled
 * in by recording a transaction and then editing it.
 *
 * `merchant` is deliberately distinct from `note` in this fixture: a wiring
 * mistake that sent the note as the merchant (or vice versa) is exactly the
 * kind of swap a fixture with two equal values cannot see.
 */
function create(
  overrides: Partial<{
    wallet_id: string;
    kind: "expense" | "income";
    amount: string;
    category_id: string;
    occurred_on: string;
    note: string;
    merchant: string | null;
  }> = {},
) {
  return {
    wallet_id: WALLET_ID,
    kind: "expense" as const,
    amount: "42.50",
    category_id: CATEGORY_ID,
    occurred_on: "2026-07-01",
    note: "weekly shop",
    merchant: "Cold Storage",
    ...overrides,
  };
}

function edit(
  overrides: Partial<{
    id: string;
    wallet_id: string;
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

function transferEdit(
  overrides: Partial<{
    transfer_id: string;
    amount_out: string;
    amount_in: string;
    occurred_on: string;
    note: string | null;
    merchant: string | null;
  }> = {},
) {
  return {
    transfer_id: TRANSFER_ID,
    // Matches the default legsLookupResult fixture (-4250/+4250, both SGD)
    // — equal magnitudes, so the default case is a balanced same-currency
    // edit unless a test overrides one side or the fixture.
    amount_out: "42.50",
    amount_in: "42.50",
    occurred_on: "2026-07-01",
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

describe("createTransaction — merchant on the create path (task 8, item 1)", () => {
  /**
   * Fails if `merchant` is dropped from `createTransaction`'s INSERT object,
   * which is precisely the state this branch shipped in: the column existed,
   * the list rendered it, the edit form wrote it, and nothing on the create
   * path ever put a value there.
   *
   * `note` is asserted alongside it, with a DIFFERENT value, so an INSERT
   * that wrote `merchant: note` (or swapped the two) fails here rather than
   * passing on a fixture where both happen to match.
   */
  it("writes the merchant it was given to the INSERT, alongside the note", async () => {
    const res = await createTransaction(create());

    expect(res).toEqual({ id: TXN_ID });
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ merchant: "Cold Storage", note: "weekly shop" }),
    );
  });

  /**
   * `transactionInput.merchant` uses the same `editableText(120, ...)` the
   * edit schemas use, so a blank arrives at the INSERT already coerced to
   * null. Fails if that field is redeclared the way `note` is on the same
   * schema (`.optional().or(z.literal(""))`), which leaves "" as "" —
   * `TransactionList`'s `merchantOf` treats a blank string as absent, so a
   * stored "" gives the row an empty primary line instead of falling back to
   * the note or the category.
   *
   * `toBeNull` AND `not.toBe("")`: `expect.objectContaining({ merchant:
   * null })` alone would also be satisfied by a missing key under some
   * matchers, and "" is the specific wrong value at issue here.
   */
  it("stores a blank merchant as null, never as an empty string", async () => {
    await createTransaction(create({ merchant: "" }));

    const payload = insertSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toHaveProperty("merchant");
    expect(payload.merchant).toBeNull();
    expect(payload.merchant).not.toBe("");
  });

  /**
   * The column-level guard, at the layer that actually writes: a merchant
   * past the column's own `length(merchant) <= 120` CHECK
   * (0016_editable_transactions.sql) must be refused with a readable message
   * BEFORE any database call, not forwarded as a raw constraint violation.
   */
  it("refuses an over-long merchant without touching the database", async () => {
    const res = await createTransaction(create({ merchant: "x".repeat(121) }));

    expect(res).toEqual({ error: "Merchant is too long" });
    expect(insertSpy).not.toHaveBeenCalled();
    expect(fromSpy).not.toHaveBeenCalled();
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

  /**
   * Fix round 1, IMPORTANT 1. The archived check is now conditional, so this
   * test's fixture had to become explicit about WHICH archived category is
   * posted: the row's own current category is `ROW_CATEGORY_ID` and the edit
   * posts `CATEGORY_ID`, so this is a NEWLY CHOSEN archived category — the
   * case that is still refused. (Before this round the row carried no
   * `category_id` at all, so the two were not distinguishable here.)
   *
   * The production change that breaks this test: writing the exemption as
   * "skip the archived check whenever the row has any category" — i.e.
   * `if (category.archived_at && !currentCategoryId)` instead of
   * `if (category.archived_at && category_id !== currentCategoryId)`. Under
   * that version this edit is accepted and this test fails. Deleting the
   * archived check outright breaks it too.
   */
  it("rejects an archived category, even if its kind matches", async () => {
    txnLookupResult.data = { wallet_id: WALLET_ID, kind: "expense", category_id: ROW_CATEGORY_ID };
    categoryResult.data = { kind: "expense", archived_at: "2026-01-01T00:00:00Z" };

    const result = await updateTransaction(edit({ category_id: CATEGORY_ID }));

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/choose a category/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1, IMPORTANT 1: an archived category made a transaction
   * permanently unsavable. Archiving "Groceries" and then opening an old
   * Groceries expense to fix its NOTE hit `"Choose a category"` while a
   * category was visibly chosen and preselected (the edit page deliberately
   * merges a row's own archived category into the picker), with no way to
   * clear the selection — `CategoryPicker`'s `onChange` is
   * `(c: Category) => void`. Ruling: an edit may KEEP an archived category
   * it already has; it may not newly CHOOSE one.
   *
   * The production change that breaks this test: restoring the unconditional
   * `if (!category || category.archived_at) return { error: "Choose a
   * category" }`, or dropping `category_id` back out of the `existing`
   * select so `currentCategoryId` is always undefined and the equality can
   * never hold. Either one turns this back into a rejection.
   *
   * `updateSpy`'s payload is asserted, not just `{ ok: true }` — an
   * exemption that let the call through but silently wrote `null` (or the
   * row's old value from the lookup rather than the posted one) would be a
   * different bug wearing the same result object.
   */
  it("accepts an edit that re-submits the row's OWN archived category unchanged", async () => {
    txnLookupResult.data = { wallet_id: WALLET_ID, kind: "expense", category_id: CATEGORY_ID };
    categoryResult.data = { kind: "expense", archived_at: "2026-01-01T00:00:00Z" };

    const result = await updateTransaction(edit({ category_id: CATEGORY_ID, note: "fixed a typo" }));

    expect(result).toEqual({ ok: true });
    const payload = updateSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({ category_id: CATEGORY_ID, note: "fixed a typo" });
  });

  /**
   * The kind check stays UNCONDITIONAL through the exemption (the controller
   * ruling is explicit that only the archived check is exempted). An
   * unchanged category always matched this row's kind at create time and
   * `kind` is not editable, so this only fires when the CATEGORY's own kind
   * changed underneath the row — cheap to keep, and the case it closes is
   * real. Breaks if the exemption is widened to skip the whole category
   * block, or if the kind check is moved inside the `!keepsItsOwnCategory`
   * branch.
   */
  it("still refuses an unchanged category whose own kind has since changed", async () => {
    txnLookupResult.data = { wallet_id: WALLET_ID, kind: "expense", category_id: CATEGORY_ID };
    categoryResult.data = { kind: "income", archived_at: "2026-01-01T00:00:00Z" };

    const result = await updateTransaction(edit({ category_id: CATEGORY_ID }));

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/doesn't match/i);
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
    // A transfer leg's category_id is always null (0003's transfer_shape
    // CHECK) — stated here rather than defaulted, since the lookup now
    // selects the column.
    txnLookupResult.data = { wallet_id: WALLET_ID, kind: "transfer", category_id: null };

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
    txnLookupResult.data = { wallet_id: WALLET_ID, kind: "income", category_id: ROW_CATEGORY_ID };
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

describe("updateTransfer", () => {
  beforeEach(() => {
    // The RPC's canned return for a successful call — two legs, opposite
    // signs, matching transferEdit()'s default "42.50"/"42.50" (4250 minor
    // units each). Individual tests override this where the scenario needs
    // to.
    updateResult.data = [
      { id: "leg-out", amount_minor: -4250 },
      { id: "leg-in", amount_minor: 4250 },
    ];
  });

  /**
   * THE assertion for this task (brief's wording), plus one line the brief's
   * version didn't have. As literally written, the brief's test only reads
   * back `updateResult.data` — this suite's OWN canned mock value — which
   * would still read `[-2500, 2500]` even if `updateTransfer` sent the wrong
   * amounts to the RPC, or never called it at all: nothing about reading a
   * variable this test itself just set proves `updateTransfer` computed or
   * forwarded anything. (Compare `updateTransaction`'s "scopes both the
   * initial lookup..." test above, which documents the identical class of
   * problem in the brief that test was written from.) The `rpcSpy` assertion
   * is what actually ties the sorted output to THIS call's input — that
   * `updateTransfer` correctly parsed a balanced same-currency edit into
   * two EQUAL 2500-minor-unit magnitudes and forwarded them, under this
   * transfer's own id, to the one statement (`update_transfer_pair`) that
   * applies them to both legs with each leg's existing sign preserved.
   * This is also "a same-currency edit posts equal magnitudes" (fix round
   * 1's first requested test) — `p_amount_out === p_amount_in` here IS that
   * property. See this task's report for how the RPC-layer discrimination
   * proof (supabase/tests/rls.sql) was carried out, given that a
   * fully-mocked unit test cannot observe a bug in the RPC's own SQL.
   */
  it("updates BOTH legs, keeping their signs opposite, with equal magnitudes for a same-currency edit", async () => {
    updateResult.data = [
      { id: "leg-out", amount_minor: -2500 },
      { id: "leg-in", amount_minor: 2500 },
    ];

    await updateTransfer(transferEdit({ amount_out: "25.00", amount_in: "25.00" }));

    const rows = updateResult.data!;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.amount_minor!).sort((a, b) => a - b)).toEqual([-2500, 2500]);
    expect(rpcSpy).toHaveBeenCalledWith(
      "update_transfer_pair",
      expect.objectContaining({ p_transfer_id: TRANSFER_ID, p_amount_out: 2500, p_amount_in: 2500 }),
    );
  });

  /**
   * Fix round 1's second requested test: "a cross-currency edit carries two
   * DIFFERENT amounts through to the RPC and succeeds." legsLookupResult's
   * two legs carry different currencies here (USD out, JPY in), so each
   * amount is parsed against its OWN leg's minor unit — a JS-level proof
   * that `updateTransfer` no longer forces one shared magnitude onto both
   * legs (fix round 1's whole point) and no longer refuses the edit outright
   * the way the removed currency-mismatch guard used to.
   */
  it("carries two different amounts through to the RPC for a cross-currency edit", async () => {
    legsLookupResult.data = [
      { wallet_id: WALLET_ID, amount_minor: -10000, currency_code: "USD" },
      { wallet_id: WALLET_IN_ID, amount_minor: 920000, currency_code: "JPY" },
    ];
    updateResult.data = [
      { id: "leg-out", amount_minor: -12000 },
      { id: "leg-in", amount_minor: 1100000 },
    ];

    const result = await updateTransfer(transferEdit({ amount_out: "120.00", amount_in: "11000" }));

    expect(result).toEqual({ ok: true });
    expect(rpcSpy).toHaveBeenCalledWith(
      "update_transfer_pair",
      expect.objectContaining({ p_transfer_id: TRANSFER_ID, p_amount_out: 12000, p_amount_in: 11000 }),
    );
  });

  /**
   * Fix round 1's third requested test: "an unbalanced SAME-currency edit
   * is refused." The balance invariant now lives entirely inside
   * update_transfer_pair (0016_editable_transactions.sql), not in this
   * action — see updateTransfer's own doc comment for why it was moved
   * there rather than duplicated. That means this mocked test can only
   * prove the JS-level HALF of the property: that when the RPC rejects an
   * unbalanced pair (`raise exception 'a same-currency transfer must
   * balance'`, identical to create_transfer's own message), updateTransfer
   * forwards that specific, readable error rather than masking it behind
   * the generic "Could not save transfer" fallback — KNOWN_TRANSFER_ERRORS
   * already allowlists this exact string (createTransfer's own use), so no
   * change was needed there. This test cannot prove the invariant is
   * actually ENFORCED — a fully-mocked test never calls real Postgres, so a
   * broken or missing balance check inside update_transfer_pair's SQL is
   * invisible here by construction, the identical limitation this task's
   * original Step 5 wrote up for the sign-preservation CASE. That proof
   * lives in supabase/tests/rls.sql instead (an unbalanced same-currency
   * edit against the real RPC, with the discrimination proof — temporarily
   * removing the check, re-running, watching it fail, restoring — captured
   * in this task's report).
   */
  it("forwards update_transfer_pair's unbalanced-same-currency rejection as a readable error", async () => {
    updateResult.data = null;
    updateResult.error = { message: "a same-currency transfer must balance", code: "P0001" };

    const result = await updateTransfer(transferEdit({ amount_out: "50.00", amount_in: "25.00" }));

    expect(result).toEqual({ error: "a same-currency transfer must balance" });
    // The rejection came from the RPC, not a JS-side guard — proving the
    // call was actually made distinguishes this from the (removed)
    // currency-mismatch guard that used to refuse before ever reaching it.
    expect(rpcSpy).toHaveBeenCalled();
  });

  /**
   * Adapted from the brief's `expect(eqSpy).toHaveBeenCalledWith("transfer_id",
   * TRANSFER_ID)` in two ways. First, the bare 2-arg shape: this file's
   * `eqSpy` always tags calls `(table, col, val)` (module comment above),
   * never 2 args — the same adaptation `updateTransaction`'s own
   * id-scoping test already documents needing. Second, "the UPDATE": with
   * the RPC mechanism this task chose, there IS no client-side `.eq()` call
   * for the write itself — `update_transfer_pair`'s WHERE clause does that
   * scoping inside Postgres, invisible to this mock. What eqSpy CAN observe
   * is the pre-flight lookup (`.eq("transfer_id", ...)`, used to learn each
   * leg's own currency and fail fast on an incomplete pair before ever
   * calling the RPC) — scoped by transfer_id, not by either leg's own id,
   * which is the property this test is actually named for.
   */
  it("scopes the pre-flight lookup by transfer_id, not by either leg's own id", async () => {
    await updateTransfer(transferEdit());

    expect(eqSpy).toHaveBeenCalledWith("transactions", "transfer_id", TRANSFER_ID);
    expect(rpcSpy).toHaveBeenCalledWith(
      "update_transfer_pair",
      expect.objectContaining({ p_transfer_id: TRANSFER_ID }),
    );
  });

  it("reports not found when the pair is incomplete", async () => {
    // The RPC itself only returned one row — e.g. a delete raced between
    // the pre-flight lookup (which still saw both legs) and the RPC call.
    updateResult.data = [{ id: "a" }];

    const result = await updateTransfer(transferEdit());

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/not found|both/i);
  });

  /**
   * The pre-flight lookup itself finding fewer than two legs — a genuinely
   * missing/foreign transfer_id, or a caller who has lost membership on one
   * of the two wallets since the transfer was created (transactions_member
   * RLS scopes this SELECT per-row, same as updateTransfer's own doc
   * comment explains). Distinct code path from the previous test (that one
   * fails at the RPC's own row count; this one never reaches the RPC at
   * all), so both are asserted.
   */
  it("reports not found when the pre-flight lookup itself finds an incomplete pair", async () => {
    legsLookupResult.data = [{ wallet_id: WALLET_ID, amount_minor: -4250, currency_code: "SGD" }];

    const result = await updateTransfer(transferEdit());

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/not found|both/i);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  /**
   * Task 8, item 3. `updateTransaction` has always refused an archived
   * wallet and `createTransfer` has always refused archived endpoints, but
   * `updateTransfer` had neither check — so a user who archived a closed
   * savings account could no longer edit an ordinary expense in it while
   * still being able to change the amount of a transfer LEG into it. Money
   * moving into an archived wallet's balance through the one path that
   * skipped the check.
   *
   * The two directions are asserted SEPARATELY and both are needed: a check
   * written against only `outLeg`'s wallet passes the first and fails the
   * second, and vice versa. That is only visible because the two legs live
   * in different wallets (`WALLET_ID` / `WALLET_IN_ID`) — with one shared
   * wallet id, either half-check would pass both.
   */
  it("refuses the edit when the OUTGOING leg's wallet is archived", async () => {
    legWalletsResult.data = [
      { id: WALLET_ID, archived_at: "2026-01-01T00:00:00Z" },
      { id: WALLET_IN_ID, archived_at: null },
    ];

    const result = await updateTransfer(transferEdit());

    expect(result).toEqual({ error: "This wallet has been archived." });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("refuses the edit when the INCOMING leg's wallet is archived", async () => {
    legWalletsResult.data = [
      { id: WALLET_ID, archived_at: null },
      { id: WALLET_IN_ID, archived_at: "2026-01-01T00:00:00Z" },
    ];

    const result = await updateTransfer(transferEdit());

    expect(result).toEqual({ error: "This wallet has been archived." });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  /**
   * The control, and the reason the two tests above mean anything: with both
   * wallets active the edit must still go through. A guard written to refuse
   * every transfer edit would pass both archived tests and look identical to
   * a correct one without this.
   *
   * The lookup itself is asserted on `inSpy` — the ids the check actually
   * asked about, on the `wallets` table — because "an error came back" cannot
   * distinguish a check that looked at both legs from one that looked at the
   * outgoing leg twice.
   */
  it("looks BOTH legs' wallets up, and lets the edit through when both are active", async () => {
    const result = await updateTransfer(transferEdit());

    expect(result).toEqual({ ok: true });
    expect(inSpy).toHaveBeenCalledWith("wallets", "id", [WALLET_ID, WALLET_IN_ID]);
    expect(rpcSpy).toHaveBeenCalled();
  });

  /**
   * A leg's wallet not coming back at all is a type-safety net, not a
   * reachable branch (the legs lookup already proved membership on the same
   * wallets through the same `is_wallet_member` predicate) — but it must not
   * fall through to a successful RPC call, which is what an
   * `if (wallet?.archived_at)` written with optional chaining would do.
   */
  it("refuses rather than proceeding when a leg's wallet cannot be read", async () => {
    legWalletsResult.data = [{ id: WALLET_ID, archived_at: null }];

    const result = await updateTransfer(transferEdit());

    expect(result).toEqual({ error: "Wallet not found" });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  /**
   * A malformed pair — both legs sharing the same sign — is a distinct
   * failure mode from "fewer than two rows": the SELECT itself returns two
   * rows, but neither `outLeg`/`inLeg` can be identified. Nothing in
   * 0003_transactions.sql's CHECK constraints actually rules this out (only
   * create_transfer's own INSERT ever produces opposite signs), so this is
   * a real, if unlikely, shape updateTransfer must not crash on or silently
   * misapply an amount against.
   */
  it("reports not found when both legs share the same sign", async () => {
    legsLookupResult.data = [
      { wallet_id: WALLET_ID, amount_minor: 4250, currency_code: "SGD" },
      { wallet_id: WALLET_IN_ID, amount_minor: 4250, currency_code: "SGD" },
    ];

    const result = await updateTransfer(transferEdit());

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/not found|both/i);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("never writes a category onto a transfer", async () => {
    await updateTransfer(transferEdit());

    // rpcSpy, not updateSpy — updateTransfer never calls
    // `.from("transactions").update(...)`, so updateSpy (which only fires
    // on that method) would never be called at all here, making the
    // brief's literal `updateSpy.mock.calls[0]![0]` throw on a `TypeError`
    // (calls[0] is undefined). This is this task's second brief-literal
    // adaptation — see this task's report.
    const args = rpcSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("category_id");
  });

  it("excludes a soft-deleted leg from the pre-flight lookup", async () => {
    await updateTransfer(transferEdit());

    expect(isSpy).toHaveBeenCalledWith("transactions", "deleted_at", null);
  });

  it("writes both amounts, occurred_on, note and merchant to the RPC", async () => {
    await updateTransfer(
      transferEdit({ note: "  Rent  ", merchant: "Landlord", amount_out: "10.00", amount_in: "10.00" }),
    );

    expect(rpcSpy).toHaveBeenCalledWith("update_transfer_pair", {
      p_transfer_id: TRANSFER_ID,
      p_amount_out: 1000,
      p_amount_in: 1000,
      p_occurred_on: "2026-07-01",
      p_note: "Rent",
      p_merchant: "Landlord",
    });
  });

  it("rejects a zero outgoing amount", async () => {
    const result = await updateTransfer(transferEdit({ amount_out: "0" }));

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/greater than zero/i);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("rejects a zero incoming amount", async () => {
    const result = await updateTransfer(transferEdit({ amount_in: "0" }));

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/greater than zero/i);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("rejects a fraction the outgoing leg's currency cannot hold, rather than truncating it", async () => {
    legsLookupResult.data = [
      { wallet_id: WALLET_ID, amount_minor: -4250, currency_code: "JPY" },
      { wallet_id: WALLET_IN_ID, amount_minor: 4250, currency_code: "JPY" },
    ];

    const result = await updateTransfer(transferEdit({ amount_out: "12.999", amount_in: "12" }));

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/no decimal places/i);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  /**
   * Each leg is parsed against its OWN currency (fix round 1) — this is the
   * test that would have failed against the original single-`amount`
   * version, which only ever checked one currency. USD out / JPY in: a
   * fraction that's fine for USD but invalid for JPY must still be caught,
   * scoped to the INCOMING leg specifically.
   */
  it("rejects a fraction the incoming leg's currency cannot hold, even when the outgoing leg's is fine", async () => {
    legsLookupResult.data = [
      { wallet_id: WALLET_ID, amount_minor: -1200, currency_code: "USD" },
      { wallet_id: WALLET_IN_ID, amount_minor: 1200, currency_code: "JPY" },
    ];

    const result = await updateTransfer(transferEdit({ amount_out: "12.00", amount_in: "12.999" }));

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/no decimal places/i);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("returns a validation error for malformed input, never touching the database", async () => {
    const result = await updateTransfer(transferEdit({ amount_out: "" }));

    if (!("error" in result)) throw new Error("expected an error result");
    expect(result.error).toBeTruthy();
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("returns an error, never throws, when the RPC itself fails for an unrecognized reason", async () => {
    updateResult.data = null;
    updateResult.error = { message: "boom", code: "XX000" };

    const result = await updateTransfer(transferEdit());

    expect(result).toEqual({ error: "Could not save transfer. Please try again." });
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await updateTransfer(transferEdit());

    expect(result).toEqual({ error: "Not signed in" });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("revalidates the layout on success", async () => {
    await updateTransfer(transferEdit());

    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});

/**
 * Re-filing a transaction into another wallet
 * (supabase/migrations/0020_transaction_wallet_move.sql).
 *
 * Every refusal below is ALSO enforced by a composite foreign key, so none
 * of these tests is guarding the security boundary — the database is. They
 * guard the messages: without them all three failures arrive as one
 * indistinguishable "Could not save transaction. Please try again.", which
 * tells a user nothing about the one thing they can act on.
 */
describe("updateTransaction — moving between wallets", () => {
  const OTHER_WALLET = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const OTHER_CATEGORY = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } } });
    txnLookupResult.data = {
      wallet_id: WALLET_ID,
      kind: "expense",
      category_id: CATEGORY_ID,
      currency_code: "USD",
      recurring_id: null,
    };
    walletLookupResult.data = { archived_at: null, currency_code: "USD" };
    categoryResult.data = { kind: "expense", archived_at: null };
    updateResult.data = [{ id: TXN_ID }];
    updateResult.error = null;
  });

  it("accepts a move to another wallet of the same currency", async () => {
    const result = await updateTransaction(
      edit({ wallet_id: OTHER_WALLET, category_id: OTHER_CATEGORY }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("looks the destination wallet up, not the one the row is currently in", async () => {
    await updateTransaction(edit({ wallet_id: OTHER_WALLET, category_id: OTHER_CATEGORY }));
    // Every check below the lookup — archived, currency, category — is only
    // meaningful if it ran against the DESTINATION. Reading the current
    // wallet here would validate the move against the wallet being left.
    expect(eqSpy).toHaveBeenCalledWith("wallets", "id", OTHER_WALLET);
  });

  it("refuses a move to a wallet in a different currency", async () => {
    walletLookupResult.data = { archived_at: null, currency_code: "JPY" };
    const result = await updateTransaction(
      edit({ wallet_id: OTHER_WALLET, category_id: OTHER_CATEGORY }),
    );
    // Left to the FK, this is a constraint violation. Reaching the user, it
    // has to say which currencies are involved: a ¥1,000 row landing in a
    // USD wallet would otherwise move that balance by $10.00 — 100x, and
    // silently, if the constraint were ever dropped.
    expect(result).toEqual({
      error: "This is a USD transaction, so it can only move to another USD wallet.",
    });
  });

  it("refuses to move a recorded recurring occurrence", async () => {
    txnLookupResult.data = {
      wallet_id: WALLET_ID,
      kind: "expense",
      category_id: CATEGORY_ID,
      currency_code: "USD",
      recurring_id: "aaaaaaaa-0000-4000-8000-00000000r001",
    };
    const result = await updateTransaction(
      edit({ wallet_id: OTHER_WALLET, category_id: OTHER_CATEGORY }),
    );
    expect(result).toEqual({
      error:
        "A recorded recurring payment stays in its rule's wallet. Delete it and record it again to move it.",
    });
  });

  it("refuses a move that keeps the old wallet's category", async () => {
    const result = await updateTransaction(
      edit({ wallet_id: OTHER_WALLET, category_id: CATEGORY_ID }),
    );
    expect(result).toEqual({ error: "Choose a category from the wallet you're moving this to" });
  });

  it("allows a move that clears the category entirely", async () => {
    // Null is a legitimate value for a non-transfer, and the honest outcome
    // when a user re-files a transaction and has not picked a new category.
    const result = await updateTransaction(edit({ wallet_id: OTHER_WALLET, category_id: null }));
    expect(result).toEqual({ ok: true });
  });

  it("applies none of the move checks when the wallet is unchanged", async () => {
    // The same-currency, recurring and category checks are gated on the
    // wallet actually changing. A recorded occurrence must stay editable in
    // every other respect — its note, its amount — which it would not be if
    // the recurring refusal fired on an ordinary edit.
    txnLookupResult.data = {
      wallet_id: WALLET_ID,
      kind: "expense",
      category_id: CATEGORY_ID,
      currency_code: "USD",
      recurring_id: "aaaaaaaa-0000-4000-8000-00000000r001",
    };
    const result = await updateTransaction(edit({ category_id: CATEGORY_ID, note: "fixed typo" }));
    expect(result).toEqual({ ok: true });
  });

  it("goes through move_transaction, never a plain UPDATE naming wallet_id", async () => {
    // `wallet_id` is deliberately NOT in the column grant
    // (0020_transaction_wallet_move.sql keeps it out), so a plain UPDATE
    // naming it would be refused at the database with a 42501 the user
    // cannot act on. The RPC is the only path that can re-file a row — and
    // it is where the "would this hide the transaction from someone?" rule
    // lives, which no constraint or policy can express.
    await updateTransaction(edit({ wallet_id: OTHER_WALLET, category_id: OTHER_CATEGORY }));

    expect(rpcSpy).toHaveBeenCalledWith(
      "move_transaction",
      expect.objectContaining({ p_id: TXN_ID, p_wallet_id: OTHER_WALLET }),
    );
    expect(updateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ wallet_id: expect.anything() }),
    );
  });

  it("uses the ordinary UPDATE, and no RPC, when the wallet is unchanged", async () => {
    await updateTransaction(edit({ category_id: CATEGORY_ID }));
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ wallet_id: expect.anything() }),
    );
  });

  it("carries the accompanying edit into the move, so the two land together", async () => {
    // A second statement after the move could half-apply: the row would be
    // in its new wallet with its old amount. update_transfer_pair (0016) set
    // the same precedent for the transfer pair.
    await updateTransaction(
      edit({
        wallet_id: OTHER_WALLET,
        category_id: OTHER_CATEGORY,
        amount: "9.99",
        note: "moved and corrected",
      }),
    );
    expect(rpcSpy).toHaveBeenCalledWith(
      "move_transaction",
      expect.objectContaining({
        p_amount_minor: -999,
        p_note: "moved and corrected",
        p_category_id: OTHER_CATEGORY,
      }),
    );
  });

  it("explains a refused move rather than reporting a generic failure", async () => {
    updateResult.error = {
      message: "moving this would hide it from 1 other member(s) of the wallet it is in",
    } as unknown as typeof updateResult.error;
    const result = await updateTransaction(
      edit({ wallet_id: OTHER_WALLET, category_id: OTHER_CATEGORY }),
    );
    expect(result).toEqual({
      error:
        "That wallet isn't shared with everyone who can see this transaction, so moving it would hide it from them.",
    });
  });
});
