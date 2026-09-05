// src/server/actions/recurring.test.ts
//
// `./recurring` carries a file-level "use server" and reaches
// `@/lib/supabase/server` -> `next/headers` / `server-only`. `npm test`
// runs with NO `.env.local`, so `vi.mock` intercepts that module before the
// real one loads — the same technique src/server/actions/wallets.test.ts
// uses, and the reason this suite exercises `createRule`/`updateRule`/
// `archiveRule`/`recordOccurrence`/`skipOccurrence`/`unskipOccurrence`'s
// real logic rather than a stand-in.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRule, updateRule, archiveRule, recordOccurrence, skipOccurrence, unskipOccurrence } from "./recurring";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_ID = "88888888-8888-4888-8888-888888888888";
const WALLET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_WALLET_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccc999";
const CATEGORY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RULE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/**
 * `vi.hoisted` because `vi.mock` factories are hoisted above this file's own
 * top-level `const`s (see the identical note in src/server/actions/
 * wallets.test.ts).
 *
 * Five tables are faked: `recurring_rules`/`transactions`/`recurring_skips`
 * share one builder (insert/update/delete/lookup), `categories` and
 * `wallets` each get their own (SELECT-only). The fake builders do NOT
 * filter — same deliberate choice wallets.test.ts's fake makes: the
 * actions' own `.eq(...)` calls are what Postgres/RLS would actually filter
 * on, and every defect under test here is precisely about what the ACTION
 * does with a result, not about reimplementing a database. So each fake
 * reports the outcome it's told to report, and the assertions are on each
 * action's return value and the payloads/arguments captured by the spies —
 * the only things a real caller (or a real query) could ever observe.
 *
 * `fromSpy`/`eqSpy` (fix round 1, Important finding) tag EVERY `.from(table)`
 * and `.eq(col, val)` call with the table it happened on. Before this, the
 * shared builder's `insertSpy`/`updateSpy`/`deleteSpy` were table-blind and
 * its `eq: () => builder` discarded its arguments entirely — the reviewer
 * mutated production six different ways (skip/record writing to the wrong
 * table, unskip dropping one or both of its `.eq` filters, unskip deleting
 * from `recurring_rules` outright, the category lookup scoped to a
 * hardcoded wrong wallet) and this suite passed 48/48 every single time,
 * because nothing recorded WHICH table or WHICH filter an operation actually
 * reached. `updateRule`'s existing "scopes the category lookup" test had
 * already solved this narrowly for `categories` alone (as `categoryEqSpy`);
 * `fromSpy`/`eqSpy` generalize that pattern to every table instead.
 */
const {
  getUser,
  insertResult,
  insertSpy,
  updateResult,
  updateSpy,
  deleteResult,
  deleteSpy,
  ruleLookupResult,
  walletLookupResult,
  categoryResult,
  fromSpy,
  eqSpy,
  revalidatePath,
} = vi.hoisted(() => ({
  getUser: vi.fn(),
  insertResult: { error: null as unknown },
  insertSpy: vi.fn(),
  updateResult: { data: null as { id: string }[] | null, error: null as unknown },
  updateSpy: vi.fn(),
  // `unskipOccurrence`'s DELETE from `recurring_skips` — a separate
  // spy/result from `updateResult` because a DELETE has no affected-row
  // payload to assert on the way an UPDATE's `.select("id")` does; only
  // whether it errored matters here.
  deleteResult: { error: null as unknown },
  deleteSpy: vi.fn(),
  // Shared by every `recurring_rules` SELECT-by-id lookup: `updateRule`
  // only ever reads `.wallet_id` off it, so the extra fields
  // `recordOccurrence` needs are optional rather than required — several
  // tests below assign a partial object. Defaults (set in `beforeEach`)
  // describe a plain monthly rule anchored on 1 July 2026, matching
  // `form()`'s own defaults (1500.00 SGD expense) so `recordOccurrence`'s
  // tests can rely on them without re-stating anything.
  ruleLookupResult: {
    data: null as {
      wallet_id: string;
      kind?: string;
      amount_minor?: number;
      currency_code?: string;
      category_id?: string;
      anchor_on?: string;
      interval_unit?: string;
      ends_on?: string | null;
      archived_at?: string | null;
    } | null,
  },
  // `recordOccurrence`'s wallet-active/currency checks, and `createRule`/
  // `updateRule`'s `checkWalletCurrency`. `data: null` represents the
  // lookup itself failing (a distinct scenario from "found but archived" —
  // fix round 1, Minor finding: the production code used to conflate them).
  walletLookupResult: {
    data: null as { archived_at: string | null; currency_code: string; space_id?: string } | null,
  },
  categoryResult: { data: null as { kind: string; archived_at: string | null } | null },
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
      if (table === "wallets") {
        // `recordOccurrence`'s wallet-active/currency checks and
        // `checkWalletCurrency`. No mode switching needed — this table is
        // only ever SELECTed, never inserted/updated/deleted.
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
      if (!["recurring_rules", "transactions", "recurring_skips"].includes(table)) {
        throw new Error(`unexpected table ${table}`);
      }
      // One shared shape for all three tables — same deliberate choice this
      // file's module comment makes for `categories`/`wallets`: the fakes
      // don't reimplement per-table behaviour, they just report whichever
      // outcome a test told them to. "lookup" is the default and stays in
      // effect for `updateRule`/`recordOccurrence`'s standalone SELECTs,
      // which never call `.insert`/`.update`/`.delete`. `createRule`'s
      // `.insert(...)` (on `recurring_rules`), `recordOccurrence`'s
      // `.insert(...)` (on `transactions`) and `skipOccurrence`'s
      // `.insert(...)` (on `recurring_skips`) all switch to "insert" and
      // resolve via the SAME `insertResult`/`insertSpy` — there is nothing
      // table-specific about how an insert error is translated, so a single
      // pair suffices and lets `skipOccurrence`'s idempotent-23505 test
      // reuse the identical `insertResult` the record-duplicate test does.
      // `fromSpy`'s per-call table tag is what lets a test tell these three
      // tables apart when it needs to (see the module comment above).
      let mode: "lookup" | "insert" | "update" | "delete" = "lookup";
      const builder: Record<string, unknown> = {
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
        delete: () => {
          mode = "delete";
          deleteSpy();
          return builder;
        },
        eq: (col: string, val: unknown) => {
          eqSpy(table, col, val);
          return builder;
        },
        select: () => builder,
        single: () => builder,
        // Real supabase-js builders are thenable at every stage of the
        // chain (wallets.test.ts's identical comment) — the same object
        // resolves correctly whether it's awaited right after `.insert(...)`
        // or several `.eq`/`.select`/`.single` calls later.
        then: (resolve: (v: unknown) => void) =>
          resolve(
            mode === "insert"
              ? insertResult
              : mode === "update"
                ? updateResult
                : mode === "delete"
                  ? deleteResult
                  : ruleLookupResult,
          ),
      };
      return builder;
    },
  }),
}));

beforeEach(() => {
  // Pins `recordOccurrence`'s internal `todayLocal()` to a known calendar
  // date (fix round 1, Important finding — `occurrenceOn` is now checked
  // against `occurrencesFor`, which needs a `today`). Constructed via LOCAL
  // components (`new Date(2026, 8, 1, ...)`, month 8 = September) and read
  // back via LOCAL getters inside `todayLocal()` itself — both sides of that
  // round trip run in whatever timezone the test machine is in, so they
  // always agree regardless of what that timezone actually is. Using the
  // REAL wall clock here instead would make these tests silently start
  // failing about a year after they were written, once the 12-month lookback
  // floor moves past this suite's fixed "2026-07-01" occurrence dates.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 1, 12, 0, 0));

  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } } });
  insertResult.error = null;
  updateResult.data = [{ id: RULE_ID }];
  updateResult.error = null;
  deleteResult.error = null;
  // Full default row, matching `form()`'s defaults below (1500.00 expense
  // SGD -> -150000 minor units, monthly, anchored 1 July 2026) —
  // `recordOccurrence`'s tests can rely on this without re-stating it, the
  // same way `createRule`'s tests rely on `categoryResult`'s default. With
  // `today` pinned at 1 September 2026 above, this anchor produces due
  // occurrences on 1 July, 1 August and 1 September.
  ruleLookupResult.data = {
    wallet_id: WALLET_ID,
    kind: "expense",
    amount_minor: -150000,
    currency_code: "SGD",
    category_id: CATEGORY_ID,
    anchor_on: "2026-07-01",
    interval_unit: "monthly",
    ends_on: null,
    archived_at: null,
  };
  walletLookupResult.data = { archived_at: null, currency_code: "SGD", space_id: SPACE_ID };
  // Matches `form()`'s default `kind: "expense"` below, so every test that
  // doesn't care about the category check can ignore it entirely.
  categoryResult.data = { kind: "expense", archived_at: null };
});

afterEach(() => {
  vi.useRealTimers();
});

function form(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  const fields: Record<string, string> = {
    wallet_id: WALLET_ID,
    name: "Rent",
    kind: "expense",
    amount: "1500.00",
    currency_code: "SGD",
    category_id: CATEGORY_ID,
    interval_unit: "monthly",
    anchor_on: "2026-09-01",
    ends_on: "",
    ...overrides,
  };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("createRule", () => {
  it("stores an expense amount as NEGATIVE minor units", async () => {
    const result = await createRule({}, form({ kind: "expense", amount: "1500.00" }));

    expect(result).toEqual({});
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ amount_minor: -150000 }));
  });

  it("stores an income amount as POSITIVE minor units", async () => {
    categoryResult.data = { kind: "income", archived_at: null };

    const result = await createRule({}, form({ kind: "income", amount: "3200.00" }));

    expect(result).toEqual({});
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ amount_minor: 320000 }));
  });

  it("never writes a transfer rule, however the form is posted", async () => {
    const res = await createRule({}, form({ kind: "transfer" }));

    expect(res.error).toBeTruthy();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("writes created_by from the session, never from the form", async () => {
    await createRule({}, form());

    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ created_by: OWNER_ID }));
  });

  /**
   * Fix round 2, I5: `fromSpy`/`eqSpy` were already instrumented into this
   * suite's fake (see the module comment above), but createRule/updateRule/
   * archiveRule never actually asserted on them — proven live: a mutation
   * pointing this INSERT at `transactions` instead of `recurring_rules`
   * left 62/62 green. The shared fake accepts either table name silently
   * (it has to, for `recordOccurrence`'s own INSERT into `transactions`),
   * so only `fromSpy`'s own record of WHICH table this call actually
   * reached can catch it.
   */
  it("inserts into recurring_rules, never a different table", async () => {
    await createRule({}, form());

    expect(fromSpy).toHaveBeenLastCalledWith("recurring_rules");
  });

  it("rejects a fraction the currency cannot hold, rather than truncating it", async () => {
    // The wallet's own currency must agree with the rule's for this test to
    // reach the precision check at all — otherwise `checkWalletCurrency`
    // (checked first) would refuse the mismatch before the amount is even
    // parsed.
    walletLookupResult.data = { archived_at: null, currency_code: "JPY", space_id: SPACE_ID };

    const result = await createRule({}, form({ currency_code: "JPY", amount: "12.999" }));

    expect(result.error).toMatch(/no decimal places/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("rejects a zero amount", async () => {
    const result = await createRule({}, form({ amount: "0" }));

    expect(result.error).toMatch(/greater than zero/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("returns an error, never throws, when the INSERT itself fails", async () => {
    insertResult.error = { message: "boom", code: "XX000" };

    const result = await createRule({}, form());

    // App-authored text, not the provider's — the module's own convention.
    expect(result).toEqual({ error: "Could not create rule. Please try again." });
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await createRule({}, form());

    expect(result).toEqual({ error: "Not signed in" });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("revalidates the layout and /recurring on success", async () => {
    await createRule({}, form());

    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/recurring");
  });

  /**
   * Fix round 1 (task-4-fix-1): the review's CRITICAL finding.
   * `recurringInput.currency_code` is a free field with nothing tying it to
   * the wallet's own — unlike manual entry (`createTransaction`), which
   * never accepts a currency from the caller and always writes the
   * wallet's. Proven live by the reviewer: a mismatched rule that reached
   * Record corrupted `get_wallet_balances`, which sums `amount_minor`
   * across every currency with no filter and labels the total with the
   * wallet's own code. Caught here, at Create, rather than only at Record.
   */
  it("rejects a rule whose currency doesn't match the wallet's currency", async () => {
    walletLookupResult.data = { archived_at: null, currency_code: "USD", space_id: SPACE_ID };

    const result = await createRule({}, form({ currency_code: "SGD" }));

    expect(result.error).toMatch(/currency/i);
    expect(result.field).toBe("currency_code");
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("returns an error, never throws, when the wallet for the currency check can't be found", async () => {
    walletLookupResult.data = null;

    const result = await createRule({}, form());

    expect(result).toEqual({ error: "Wallet not found" });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1 (task-3-fix-1): the review's Critical finding. Without this
   * check, an expense rule pointed at an income category (or vice versa)
   * was created successfully and then permanently un-recordable — every
   * later attempt to record an occurrence inserts a transaction with the
   * rule's fixed kind/category, and `createTransaction`'s own identical
   * check (transactions.ts:147) refuses it, forever.
   *
   * Task 5 fix round 1: the message text no longer copies transactions.ts's
   * wording verbatim ("That category doesn't match this transaction type")
   * — /recurring's own UI copy never says "transaction," and a rule isn't
   * one (spec §1.2). See `checkCategory`'s own doc comment for the full
   * reasoning.
   */
  it("rejects a category whose kind doesn't match the rule's kind", async () => {
    categoryResult.data = { kind: "income", archived_at: null };

    const result = await createRule({}, form({ kind: "expense" }));

    expect(result.error).toBe("That category doesn't match this type");
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("accepts a category whose kind matches the rule's kind", async () => {
    categoryResult.data = { kind: "expense", archived_at: null };

    const result = await createRule({}, form({ kind: "expense" }));

    expect(result).toEqual({});
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * The task-3-fix-1 decision on archived categories: rejected on create,
   * same as transactions.ts's `createTransaction` rejects one for a brand
   * new transaction (spec §5.3 — archiving "hides it from pickers" for
   * anything NEW). A brand-new rule pointed at an already-archived category
   * would be exactly as permanently un-recordable as a kind mismatch.
   */
  it("rejects an archived category, even if its kind matches", async () => {
    categoryResult.data = { kind: "expense", archived_at: "2026-01-01T00:00:00Z" };

    const result = await createRule({}, form({ kind: "expense" }));

    expect(result.error).toBe("Choose a category");
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe("updateRule", () => {
  it("writes the amount as signed minor units and never writes wallet_id or created_by", async () => {
    categoryResult.data = { kind: "income", archived_at: null };

    const result = await updateRule(RULE_ID, {}, form({ kind: "income", amount: "3200.00" }));

    expect(result).toEqual({});
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = updateSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.amount_minor).toBe(320000);
    expect(payload).not.toHaveProperty("wallet_id");
    expect(payload).not.toHaveProperty("created_by");
  });

  it("returns an error rather than reporting success when the UPDATE matches no row", async () => {
    updateResult.data = [];

    const result = await updateRule(RULE_ID, {}, form());

    expect(result).toEqual({ error: "Rule not found" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns an error, never throws, when the UPDATE itself fails", async () => {
    updateResult.data = null;
    updateResult.error = { message: "boom", code: "XX000" };

    const result = await updateRule(RULE_ID, {}, form());

    expect(result).toEqual({ error: "Could not update rule. Please try again." });
  });

  it("never writes a transfer rule, however the form is posted", async () => {
    const result = await updateRule(RULE_ID, {}, form({ kind: "transfer" }));

    expect(result.error).toBeTruthy();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await updateRule(RULE_ID, {}, form());

    expect(result).toEqual({ error: "Not signed in" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("returns 'Rule not found' when the rule's own wallet_id can't be looked up", async () => {
    ruleLookupResult.data = null;

    const result = await updateRule(RULE_ID, {}, form());

    expect(result).toEqual({ error: "Rule not found" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1 (task-4-fix-1): same CRITICAL gap as `createRule`'s, on the
   * edit path — see that describe block's identical test for the full
   * reasoning.
   */
  it("rejects an edit whose currency doesn't match the wallet's currency", async () => {
    walletLookupResult.data = { archived_at: null, currency_code: "USD", space_id: SPACE_ID };

    const result = await updateRule(RULE_ID, {}, form({ currency_code: "SGD" }));

    expect(result.error).toMatch(/currency/i);
    expect(result.field).toBe("currency_code");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1 (task-3-fix-1): same Critical gap as `createRule`'s, on the
   * edit path. Task 5 fix round 1: message wording updated — see the
   * identical comment above `createRule`'s own version of this test.
   */
  it("rejects a category whose kind doesn't match the rule's kind", async () => {
    categoryResult.data = { kind: "income", archived_at: null };

    const result = await updateRule(RULE_ID, {}, form({ kind: "expense" }));

    expect(result.error).toBe("That category doesn't match this type");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("accepts a category whose kind matches the rule's kind", async () => {
    categoryResult.data = { kind: "expense", archived_at: null };

    const result = await updateRule(RULE_ID, {}, form({ kind: "expense" }));

    expect(result).toEqual({});
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * task-3-fix-1's decision, applied to edit too (deliberately NOT deferred
   * the way transactions.ts's own comment defers the archived-on-edit
   * question for a *transaction*): a rule exists to be recorded again in
   * the future, so saving an edit that leaves it pointed at an archived
   * category would strand it exactly as permanently un-recordable as a
   * kind mismatch would.
   */
  it("rejects an archived category, even if its kind matches", async () => {
    categoryResult.data = { kind: "expense", archived_at: "2026-01-01T00:00:00Z" };

    const result = await updateRule(RULE_ID, {}, form({ kind: "expense" }));

    expect(result.error).toBe("Choose a category");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  /**
   * The security property `checkCategory`'s call site in `updateRule` exists
   * for: `wallet_id` cannot be changed via UPDATE (0015's column-scoped
   * grant), so the category lookup must be scoped by the rule's OWN
   * (looked-up) wallet_id, never the one posted in the form — otherwise a
   * caller could post an unrelated wallet_id whose categories happen to
   * satisfy the kind check while the row itself stays on its real wallet.
   *
   * Fix round 1: now asserted via the general `eqSpy(table, col, val)`
   * rather than a `categories`-only spy — see this file's module comment.
   */
  it("scopes the category lookup to the rule's own wallet, not the posted one", async () => {
    ruleLookupResult.data = { wallet_id: OTHER_WALLET_ID };

    await updateRule(RULE_ID, {}, form({ wallet_id: WALLET_ID }));

    // Since 0022 a category belongs to the HOUSEHOLD, so checkCategory
    // resolves the wallet's space first and filters categories by that. The
    // property this test exists for is unchanged and is now observable one
    // step earlier: the wallet it resolves must be the rule's own, never the
    // one the caller posted.
    expect(eqSpy).toHaveBeenCalledWith("wallets", "id", OTHER_WALLET_ID);
    expect(eqSpy).not.toHaveBeenCalledWith("wallets", "id", WALLET_ID);
    expect(eqSpy).toHaveBeenCalledWith("categories", "space_id", SPACE_ID);
  });

  /**
   * Fix round 2, I5: proven live — dropping the UPDATE's own `.eq("id",
   * id)` left 62/62 green, which means editing ONE rule would rewrite
   * EVERY rule in the household (RLS still scopes it to the caller's own
   * wallets, but not to this one rule). `updateRule` calls `.eq("id", id)`
   * TWICE on `recurring_rules` in the success path — once for the initial
   * `.select("wallet_id")` lookup, once for the UPDATE itself — so the
   * mutation is caught by the count dropping from two to one, not merely
   * by the call having happened at all (which the lookup alone would
   * already satisfy).
   */
  it("scopes both the initial lookup and the UPDATE itself to this rule's id", async () => {
    await updateRule(RULE_ID, {}, form());

    const recurringRuleIdCalls = eqSpy.mock.calls.filter(
      ([table, col, val]) => table === "recurring_rules" && col === "id" && val === RULE_ID,
    );
    expect(recurringRuleIdCalls).toHaveLength(2);
  });
});

describe("archiveRule", () => {
  it("archives rather than deleting, so recorded history is untouched", async () => {
    const result = await archiveRule(RULE_ID);

    expect(result).toEqual({});
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ archived_at: expect.anything() }));
  });

  it("revalidates the layout and /recurring on success", async () => {
    await archiveRule(RULE_ID);

    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/recurring");
  });

  /**
   * Fix round 2, I5: proven live — dropping this UPDATE's `.eq("id", id)`
   * left 62/62 green, which means pausing ONE rule would pause EVERY rule
   * in the household. `archiveRule` has no separate lookup step (unlike
   * `updateRule`), so a single `eqSpy` call is the entire filter this
   * UPDATE carries.
   */
  it("scopes the UPDATE to this rule's id", async () => {
    await archiveRule(RULE_ID);

    expect(eqSpy).toHaveBeenCalledWith("recurring_rules", "id", RULE_ID);
  });

  /**
   * The defect this test exists for — wallets.ts's `archiveWallet` and
   * categories.ts's `archiveCategory` both carry an identical test with an
   * identical comment. Zero affected rows is not an error in Postgres, and
   * PostgREST reports none, so without checking `data.length` this action
   * would return `{}` and the UI would report success while the database
   * was untouched.
   */
  it("returns an error rather than reporting success when the UPDATE matches no row", async () => {
    updateResult.data = [];

    const result = await archiveRule(RULE_ID);

    expect(result).toEqual({ error: "Rule not found" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns an error, never throws, when the UPDATE itself fails", async () => {
    updateResult.data = null;
    updateResult.error = { message: "boom", code: "XX000" };

    const result = await archiveRule(RULE_ID);

    expect(result).toEqual({ error: "Could not archive rule. Please try again." });
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await archiveRule(RULE_ID);

    expect(result).toEqual({ error: "Not signed in" });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe("recordOccurrence", () => {
  it("dates the transaction to the OCCURRENCE, not to today, and returns success", async () => {
    // The whole of spec §1.3 rests on this. Recording July's rent in
    // September must produce a 1 July transaction, or "each lands on its
    // own date" is cosmetic and July's report is still wrong.
    //
    // Fix round 1 (Fix 4): the success RETURN VALUE is now pinned too —
    // mutating a success path to `return { error: "bogus" }` used to pass
    // 48/48, since nothing asserted the return value on the happy path.
    const result = await recordOccurrence(RULE_ID, "2026-07-01");

    expect(result).toEqual({});
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ occurred_on: "2026-07-01", recurring_id: RULE_ID }),
    );
  });

  /**
   * Fix round 1 (0016 fix round 1, CRITICAL): this is the class of test
   * that should have caught the production defect — the sibling test above
   * uses `objectContaining`, a PARTIAL matcher, so it stayed green with
   * `recurring_occurrence_on` entirely absent from the insert. Once
   * `recurring_occurrence_needs_rule` (0016_editable_transactions.sql)
   * existed on the real table, that omission made every single Record tap
   * fail live with a 23514 the old handler couldn't translate ("Could not
   * record this occurrence. Please try again." — advice that could never
   * work), and no test here said so. `recurring_occurrence_on` is the
   * occurrence's IDENTITY, written equal to `occurrenceOn` at Record time
   * — see this function's own doc comment.
   */
  it("writes recurring_occurrence_on equal to the occurrence date, not just occurred_on", async () => {
    await recordOccurrence(RULE_ID, "2026-07-01");

    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ recurring_occurrence_on: "2026-07-01" }),
    );
  });

  it("copies the rule's kind, amount, currency, category and wallet", async () => {
    await recordOccurrence(RULE_ID, "2026-07-01");

    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "expense",
        amount_minor: -150000,
        currency_code: "SGD",
        category_id: CATEGORY_ID,
        wallet_id: WALLET_ID,
      }),
    );
  });

  it("writes created_by from the session, never from the caller", async () => {
    await recordOccurrence(RULE_ID, "2026-07-01");

    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ created_by: OWNER_ID }));
  });

  /**
   * Fix round 1 (Fix 3): the reviewer proved this suite could not tell
   * `recordOccurrence` apart from `skipOccurrence` at the table level — a
   * mutation pointing this insert at `recurring_skips` instead of
   * `transactions` passed 48/48, because the shared insert mock's
   * error-handling behaviour genuinely IS table-agnostic (that's the whole
   * point of sharing it), so nothing about the RETURN VALUE would differ.
   * `fromSpy` is what makes the table itself observable.
   */
  it("inserts into transactions, not recurring_skips", async () => {
    await recordOccurrence(RULE_ID, "2026-07-01");

    expect(fromSpy).toHaveBeenLastCalledWith("transactions");
  });

  /**
   * Fix round 1 (Fix 6): unpinned before this — hardcoding the category
   * lookup's wallet scope to a fixed (even correct-looking) value passed
   * 48/48, because every other test's rule happens to live on `WALLET_ID`
   * anyway. Mirrors `updateRule`'s identical test.
   */
  it("scopes the category lookup to the rule's own wallet, not a hardcoded one", async () => {
    ruleLookupResult.data = { ...ruleLookupResult.data!, wallet_id: OTHER_WALLET_ID };

    await recordOccurrence(RULE_ID, "2026-07-01");

    expect(eqSpy).toHaveBeenCalledWith("wallets", "id", OTHER_WALLET_ID);
    expect(eqSpy).not.toHaveBeenCalledWith("wallets", "id", WALLET_ID);
    expect(eqSpy).toHaveBeenCalledWith("categories", "space_id", SPACE_ID);
  });

  it("rejects a shape-invalid occurrence date", async () => {
    const res = await recordOccurrence(RULE_ID, "07/01/2026");

    expect(res.error).toMatch(/valid date/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("rejects a calendar-invalid occurrence date", async () => {
    // A bare `\d{4}-\d{2}-\d{2}` regex would let this through to Postgres
    // as a raw driver error — same reasoning as transaction.ts's
    // `occurred_on` and this file's own `anchor_on`/`ends_on`.
    const res = await recordOccurrence(RULE_ID, "2026-02-30");

    expect(res.error).toMatch(/valid date/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1 (Fix 2, Important finding): `occurrenceOn` used to be
   * accepted with no relationship to the rule's actual schedule at all.
   * Anchored monthly on the 1st, the 15th is never an occurrence.
   */
  it("refuses a date that isn't an occurrence of this rule's schedule", async () => {
    const res = await recordOccurrence(RULE_ID, "2026-07-15");

    expect(res.error).toMatch(/due occurrence/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1 (Fix 2): the chief reason this check exists. 1 October is
   * ON schedule (the anchor's 3rd monthly step) but AFTER "today" (pinned
   * at 1 September) — recording it would assert October's rent was paid in
   * September, contradicting spec §1.1 and §3.3, and is reachable from a
   * stale tab or a clock-skewed client, not only by malice.
   */
  it("refuses a date the rule hasn't reached yet", async () => {
    const res = await recordOccurrence(RULE_ID, "2026-10-01");

    expect(res.error).toMatch(/due occurrence/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1 (Fix 2): `archiveRule` is the spec's "pause" (§5). A paused
   * rule used to stay fully recordable by direct POST.
   */
  it("refuses to record a paused rule", async () => {
    ruleLookupResult.data = { ...ruleLookupResult.data!, archived_at: "2026-01-01T00:00:00Z" };

    const res = await recordOccurrence(RULE_ID, "2026-07-01");

    expect(res.error).toMatch(/paused/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("refuses to record against an archived wallet, with a readable reason", async () => {
    walletLookupResult.data = { archived_at: "2026-06-01T00:00:00Z", currency_code: "SGD" };

    const res = await recordOccurrence(RULE_ID, "2026-07-01");

    expect(res.error).toMatch(/archived/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1 (Fix 5, Minor): `if (!wallet || wallet.archived_at)` used
   * to report "This wallet has been archived." for BOTH cases, which is
   * false and unactionable when the lookup itself simply failed.
   */
  it("returns a distinct error, not 'archived', when the wallet lookup itself fails", async () => {
    walletLookupResult.data = null;

    const res = await recordOccurrence(RULE_ID, "2026-07-01");

    expect(res.error).toBeTruthy();
    expect(res.error).not.toMatch(/archived/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1 (CRITICAL): spec §4 names three re-validations for Record;
   * this is the one the original brief dropped. `createTransaction` writes
   * the WALLET'S currency, so manual entry structurally cannot mismatch;
   * `recordOccurrence` writes the RULE'S, and nothing else ties the two.
   * Proven live by the reviewer: an inserted mismatch corrupted
   * `get_wallet_balances`, which sums `amount_minor` with no currency
   * filter. Refuses rather than substituting the wallet's currency, which
   * would re-denominate the amount and misprice it by orders of magnitude.
   */
  it("refuses to record when the wallet's currency no longer matches the rule's", async () => {
    walletLookupResult.data = { archived_at: null, currency_code: "USD", space_id: SPACE_ID };

    const res = await recordOccurrence(RULE_ID, "2026-07-01");

    expect(res.error).toMatch(/currency/i);
    expect(res.error).toContain("SGD");
    expect(res.error).toContain("USD");
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("reports a duplicate record as already done, not as a crash", async () => {
    // The partial unique index is the real guard (two tabs, a double tap, a
    // retry). The user must see something sane rather than a Postgres error.
    insertResult.error = { code: "23505", message: "duplicate key" };

    const res = await recordOccurrence(RULE_ID, "2026-07-01");

    expect(res.error).toMatch(/already recorded/i);
  });

  it("returns an error, never throws, when the INSERT fails for a reason other than a duplicate", async () => {
    insertResult.error = { code: "XX000", message: "boom" };

    const res = await recordOccurrence(RULE_ID, "2026-07-01");

    // App-authored text, not the provider's — this module's own convention.
    expect(res).toEqual({ error: "Could not record this occurrence. Please try again." });
  });

  /**
   * Fix round 1 (0016 fix round 1): 23514 is `recurring_occurrence_needs_rule`
   * (0016_editable_transactions.sql) — unreachable given this insert's own
   * shape (see the doc comment above `recordOccurrence`), but mapped to its
   * own readable message rather than falling through to the generic retry
   * advice above, which could never fix a check-constraint violation. This
   * is defence in depth against exactly the class of drift that produced
   * the CRITICAL finding above: if a future edit ever drops
   * `recurring_occurrence_on` from the insert again, a real user sees an
   * accurate message instead of "try again" advice that can't work.
   */
  it("maps a check-constraint violation (23514) to a readable message, not the generic retry advice", async () => {
    insertResult.error = { code: "23514", message: "new row violates check constraint" };

    const res = await recordOccurrence(RULE_ID, "2026-07-01");

    expect(res.error).toMatch(/invalid/i);
    expect(res.error).not.toBe("Could not record this occurrence. Please try again.");
  });

  it("rejects a category whose kind no longer matches the rule's kind", async () => {
    // The rule's own kind/category pairing was validated at create/edit
    // time, but the category can change (or be re-pointed) afterward —
    // this is the same defence-in-depth checkCategory exists for there.
    categoryResult.data = { kind: "income", archived_at: null };

    const res = await recordOccurrence(RULE_ID, "2026-07-01");

    expect(res.error).toBe("That category doesn't match this type");
    expect(insertSpy).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1 (Fix 5, Minor): `checkCategory`'s "Choose a category"
   * wording assumes a screen with a picker to redirect the user to —
   * `createRule`/`updateRule` both have one; the Record surface (a
   * due-items list, spec §4: "its due items render with the reason
   * stated") does not.
   */
  it("rejects an archived category with a reason the Record screen can act on, not 'Choose a category'", async () => {
    categoryResult.data = { kind: "expense", archived_at: "2026-01-01T00:00:00Z" };

    const res = await recordOccurrence(RULE_ID, "2026-07-01");

    expect(res.error).toBe("This rule's category has been archived.");
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("returns 'Rule not found' when the rule can't be looked up (RLS or a bad id)", async () => {
    ruleLookupResult.data = null;

    const res = await recordOccurrence(RULE_ID, "2026-07-01");

    expect(res).toEqual({ error: "Rule not found" });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1 (Fix 5, Minor): a failed `nonTransferKind` parse used to
   * report "Rule not found", which is false — the rule WAS found; it's the
   * data that's malformed.
   */
  it("reports a malformed kind as invalid data, not as 'Rule not found'", async () => {
    ruleLookupResult.data = { ...ruleLookupResult.data!, kind: "transfer" };

    const res = await recordOccurrence(RULE_ID, "2026-07-01");

    expect(res.error).toMatch(/invalid/i);
    expect(res.error).not.toBe("Rule not found");
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const res = await recordOccurrence(RULE_ID, "2026-07-01");

    expect(res).toEqual({ error: "Not signed in" });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("revalidates the layout on success", async () => {
    await recordOccurrence(RULE_ID, "2026-07-01");

    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});

describe("skipOccurrence", () => {
  it("inserts a skip row for the rule and occurrence", async () => {
    const res = await skipOccurrence(RULE_ID, "2026-07-01");

    expect(res).toEqual({});
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ rule_id: RULE_ID, occurrence_on: "2026-07-01" }),
    );
  });

  // Fix round 2, small finding: `recordOccurrence` already shape-validates
  // `occurrenceOn` with `z.iso.date()` (see its own identical pair of
  // tests); this action didn't, so a calendar-invalid date reached Postgres
  // as a raw driver error instead of this file's own translated messages.
  it("rejects a shape-invalid occurrence date", async () => {
    const res = await skipOccurrence(RULE_ID, "07/01/2026");

    expect(res.error).toMatch(/valid date/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("rejects a calendar-invalid occurrence date", async () => {
    const res = await skipOccurrence(RULE_ID, "2026-02-30");

    expect(res.error).toMatch(/valid date/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1 (Fix 3): the reviewer proved this suite could not tell
   * `skipOccurrence` apart from `recordOccurrence` at the table level — a
   * mutation pointing this insert at `transactions` instead of
   * `recurring_skips` passed 48/48. `fromSpy` makes the table observable.
   */
  it("writes into recurring_skips, not transactions", async () => {
    await skipOccurrence(RULE_ID, "2026-07-01");

    expect(fromSpy).toHaveBeenLastCalledWith("recurring_skips");
  });

  /**
   * Fix round 1 (Fix 6): unpinned before this — removing `created_by`
   * entirely passed 48/48, since the only existing assertion named
   * `rule_id`/`occurrence_on` via `objectContaining`. Mirrors
   * `recordOccurrence`'s equivalent test.
   */
  it("writes created_by from the session", async () => {
    await skipOccurrence(RULE_ID, "2026-07-01");

    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ created_by: OWNER_ID }));
  });

  it("skips idempotently", async () => {
    insertResult.error = { code: "23505", message: "duplicate key" };

    const res = await skipOccurrence(RULE_ID, "2026-07-01");

    // Skipping twice is the same as skipping once — the composite PK says
    // so, and the user should not see an error for reaching the state they
    // wanted.
    expect(res).toEqual({});
  });

  it("returns an error, never throws, when the INSERT fails for a reason other than a duplicate", async () => {
    insertResult.error = { code: "XX000", message: "boom" };

    const res = await skipOccurrence(RULE_ID, "2026-07-01");

    expect(res).toEqual({ error: "Could not skip this occurrence. Please try again." });
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const res = await skipOccurrence(RULE_ID, "2026-07-01");

    expect(res).toEqual({ error: "Not signed in" });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("revalidates the layout on success", async () => {
    await skipOccurrence(RULE_ID, "2026-07-01");

    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});

describe("unskipOccurrence", () => {
  /**
   * Fix round 1 (Fix 3, the CRITICAL data-loss finding): the ORIGINAL
   * version of this test was named "deletes the skip row for the rule and
   * occurrence" and asserted only that `deleteSpy` was called once — true
   * whether the DELETE carried zero, one, or both of its `.eq` filters.
   * The reviewer proved this by mutating production six ways (dropping the
   * `occurrence_on` filter, dropping BOTH filters, and retargeting the
   * whole call at `recurring_rules`) and this suite passed 48/48 every
   * time. Without the `occurrence_on` filter specifically,
   * `delete from recurring_skips where rule_id = $1` wipes the rule's
   * ENTIRE skip history in one call, and every one of those periods
   * silently returns to the DUE list — this is live data loss, not a
   * cosmetic gap.
   *
   * (Fix 4's "give the zero-rows-matched test a real distinction, or
   * remove it" is resolved by removing it: production deliberately does
   * NOT branch on the DELETE's affected-row count — confirmed correct in
   * the fix brief's own "explicitly not to change" list — so there is no
   * code path for a mock row count to exercise differently, and the two
   * versions of that old test really were behaviourally identical. The
   * coverage that test was reaching for (unskip succeeds regardless of
   * whether a matching row exists) is a property of Postgres DELETE
   * semantics, not of this action's logic, and the property that actually
   * needed a test — correct scoping — is what this test now proves.)
   */
  it("deletes from recurring_skips, scoped by BOTH rule_id and occurrence_on", async () => {
    const res = await unskipOccurrence(RULE_ID, "2026-07-01");

    expect(res).toEqual({});
    expect(fromSpy).toHaveBeenLastCalledWith("recurring_skips");
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(eqSpy).toHaveBeenCalledWith("recurring_skips", "rule_id", RULE_ID);
    expect(eqSpy).toHaveBeenCalledWith("recurring_skips", "occurrence_on", "2026-07-01");
    expect(eqSpy).toHaveBeenCalledTimes(2);
  });

  it("returns an error, never throws, when the DELETE itself fails", async () => {
    deleteResult.error = { code: "XX000", message: "boom" };

    const res = await unskipOccurrence(RULE_ID, "2026-07-01");

    expect(res).toEqual({ error: "Could not undo the skip. Please try again." });
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const res = await unskipOccurrence(RULE_ID, "2026-07-01");

    expect(res).toEqual({ error: "Not signed in" });
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("revalidates the layout on success", async () => {
    await unskipOccurrence(RULE_ID, "2026-07-01");

    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});
