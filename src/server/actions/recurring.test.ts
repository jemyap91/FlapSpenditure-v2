// src/server/actions/recurring.test.ts
//
// `./recurring` carries a file-level "use server" and reaches
// `@/lib/supabase/server` -> `next/headers` / `server-only`. `npm test`
// runs with NO `.env.local`, so `vi.mock` intercepts that module before the
// real one loads — the same technique src/server/actions/wallets.test.ts
// uses, and the reason this suite exercises `createRule`/`updateRule`/
// `archiveRule`'s real logic rather than a stand-in.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRule, updateRule, archiveRule } from "./recurring";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WALLET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_WALLET_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccc999";
const CATEGORY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RULE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/**
 * `vi.hoisted` because `vi.mock` factories are hoisted above this file's own
 * top-level `const`s (see the identical note in src/server/actions/
 * wallets.test.ts).
 *
 * Three tables are faked: `recurring_rules` (insert/update, plus
 * `updateRule`'s standalone SELECT of the rule's own `wallet_id`) and
 * `categories` (the kind/archived lookup `checkCategory` performs). The
 * fake builders do NOT filter — same deliberate choice wallets.test.ts's
 * fake makes: the actions' own `.eq(...)` calls are what Postgres/RLS would
 * actually filter on, and every defect under test here is precisely about
 * what the ACTION does with a result, not about reimplementing a database.
 * So each fake reports the outcome it's told to report, and the assertions
 * are on each action's return value and the payloads/arguments captured by
 * the spies — the only things a real caller (or a real query) could ever
 * observe.
 */
const {
  getUser,
  insertResult,
  insertSpy,
  updateResult,
  updateSpy,
  ruleLookupResult,
  categoryResult,
  categoryEqSpy,
  revalidatePath,
} = vi.hoisted(() => ({
  getUser: vi.fn(),
  insertResult: { error: null as unknown },
  insertSpy: vi.fn(),
  updateResult: { data: null as { id: string }[] | null, error: null as unknown },
  updateSpy: vi.fn(),
  ruleLookupResult: { data: null as { wallet_id: string } | null },
  categoryResult: { data: null as { kind: string; archived_at: string | null } | null },
  // Captures every `.eq(col, val)` the categories lookup makes — the
  // "scopes to the rule's OWN wallet_id, not the posted one" test below
  // depends on seeing exactly which wallet_id reached the query, which the
  // action's return value alone can't reveal.
  categoryEqSpy: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    from: (table: string) => {
      if (table === "categories") {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (col: string, val: unknown) => {
            categoryEqSpy(col, val);
            return builder;
          },
          single: () => builder,
          then: (resolve: (v: unknown) => void) => resolve(categoryResult),
        };
        return builder;
      }
      if (table !== "recurring_rules") throw new Error(`unexpected table ${table}`);
      // "lookup" is the default and stays in effect for `updateRule`'s
      // standalone `.select("wallet_id").eq("id", id).single()`, which
      // never calls `.insert` or `.update`. `createRule`'s `.insert(...)`
      // and `updateRule`/`archiveRule`'s `.update(...).eq(...).select(...)`
      // each switch the mode explicitly, the same way wallets.test.ts's
      // fake switches between its own "count" and "update" modes.
      let mode: "lookup" | "insert" | "update" = "lookup";
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
        eq: () => builder,
        select: () => builder,
        single: () => builder,
        // Real supabase-js builders are thenable at every stage of the
        // chain (wallets.test.ts's identical comment) — the same object
        // resolves correctly whether it's awaited right after `.insert(...)`
        // or several `.eq`/`.select`/`.single` calls later.
        then: (resolve: (v: unknown) => void) =>
          resolve(mode === "insert" ? insertResult : mode === "update" ? updateResult : ruleLookupResult),
      };
      return builder;
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } } });
  insertResult.error = null;
  updateResult.data = [{ id: RULE_ID }];
  updateResult.error = null;
  ruleLookupResult.data = { wallet_id: WALLET_ID };
  // Matches `form()`'s default `kind: "expense"` below, so every test that
  // doesn't care about the category check can ignore it entirely.
  categoryResult.data = { kind: "expense", archived_at: null };
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

  it("rejects a fraction the currency cannot hold, rather than truncating it", async () => {
    const result = await createRule(
      {},
      form({ currency_code: "JPY", amount: "12.999" }),
    );

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
   * Fix round 1 (task-3-fix-1): the review's Critical finding. Without this
   * check, an expense rule pointed at an income category (or vice versa)
   * was created successfully and then permanently un-recordable — every
   * later attempt to record an occurrence inserts a transaction with the
   * rule's fixed kind/category, and `createTransaction`'s own identical
   * check (transactions.ts:147) refuses it, forever. Message text is
   * copied verbatim from that check, not reinvented.
   */
  it("rejects a category whose kind doesn't match the rule's kind, with transactions.ts's exact message", async () => {
    categoryResult.data = { kind: "income", archived_at: null };

    const result = await createRule({}, form({ kind: "expense" }));

    expect(result.error).toBe("That category doesn't match this transaction type");
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
   * Fix round 1 (task-3-fix-1): same Critical gap as `createRule`'s, on the
   * edit path. Message text copied verbatim from transactions.ts:147.
   */
  it("rejects a category whose kind doesn't match the rule's kind, with transactions.ts's exact message", async () => {
    categoryResult.data = { kind: "income", archived_at: null };

    const result = await updateRule(RULE_ID, {}, form({ kind: "expense" }));

    expect(result.error).toBe("That category doesn't match this transaction type");
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
   */
  it("scopes the category lookup to the rule's own wallet_id, not the posted one", async () => {
    ruleLookupResult.data = { wallet_id: OTHER_WALLET_ID };

    await updateRule(RULE_ID, {}, form({ wallet_id: WALLET_ID }));

    expect(categoryEqSpy).toHaveBeenCalledWith("wallet_id", OTHER_WALLET_ID);
    expect(categoryEqSpy).not.toHaveBeenCalledWith("wallet_id", WALLET_ID);
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
