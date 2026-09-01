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
const CATEGORY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RULE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/**
 * `vi.hoisted` because `vi.mock` factories are hoisted above this file's own
 * top-level `const`s (see the identical note in src/server/actions/
 * wallets.test.ts). Two spies, one per statement shape this module issues:
 * `insertSpy` captures `createRule`'s INSERT payload (the sign-application
 * assertions below depend on seeing exactly what reached the table),
 * `updateSpy` captures `updateRule`'s and `archiveRule`'s UPDATE payload
 * (whether `wallet_id`/`created_by` ever appear in it is the whole point of
 * this file's module doc comment).
 *
 * The fake builder does NOT filter, the same deliberate choice
 * wallets.test.ts's fake makes: `updateRule`/`archiveRule`'s own `.eq("id",
 * ...)` is what Postgres and RLS would actually filter on, and the defect
 * those actions guard against is precisely that a zero-row UPDATE is not an
 * error in Postgres. So the fake reports the outcome directly —
 * `insertResult` for the INSERT, `updateResult` for the UPDATE — and the
 * assertions are on each action's return value, which is the only thing the
 * user ever sees.
 */
const { getUser, insertResult, insertSpy, updateResult, updateSpy, revalidatePath } = vi.hoisted(
  () => ({
    getUser: vi.fn(),
    insertResult: { error: null as unknown },
    insertSpy: vi.fn(),
    updateResult: { data: null as { id: string }[] | null, error: null as unknown },
    updateSpy: vi.fn(),
    revalidatePath: vi.fn(),
  }),
);

vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    from: (table: string) => {
      if (table !== "recurring_rules") throw new Error(`unexpected table ${table}`);
      let mode: "insert" | "update" = "insert";
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
        // Real supabase-js builders are thenable at every stage of the
        // chain: `createRule` awaits the builder right after `.insert(...)`
        // (no `.select()`), while `updateRule`/`archiveRule` await it after
        // `.eq(...).select(...)`. Both are satisfied by making every stage
        // resolve to the outcome for the mode currently in effect.
        then: (resolve: (v: unknown) => void) =>
          resolve(mode === "insert" ? insertResult : updateResult),
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
});

describe("updateRule", () => {
  it("writes the amount as signed minor units and never writes wallet_id or created_by", async () => {
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
