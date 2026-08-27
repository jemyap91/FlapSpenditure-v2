// src/server/actions/wallets.test.ts
//
// `./wallets` carries a file-level "use server" and reaches
// `@/lib/supabase/server` -> `next/headers` / `server-only`, plus
// `next/navigation`'s `redirect`. `npm test` runs with NO `.env.local`, so
// `vi.mock` intercepts every one of those before the real modules load —
// the same technique src/server/actions/invites.test.ts uses, and the
// reason this suite exercises `archiveWallet`'s real logic rather than a
// stand-in.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { archiveWallet } from "./wallets";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WALLET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * `vi.hoisted` because `vi.mock` factories are hoisted above this file's
 * own top-level `const`s (see the identical note in
 * src/server/actions/invites.test.ts).
 *
 * The fake builder does NOT filter: `archiveWallet`'s own `.eq("owner_id",
 * ...)` / `.eq("id", ...)` are what Postgres would filter on, and the
 * defect under test is precisely that the action never LOOKED at how many
 * rows that filtering left. So the fake reports the outcome directly —
 * `countResult` for the head-count query, `updateResult` for the UPDATE —
 * and the assertions are on `archiveWallet`'s return value, which is the
 * only thing the user ever sees.
 */
const { getUser, countResult, updateResult, revalidatePath } = vi.hoisted(() => ({
  getUser: vi.fn(),
  countResult: { count: 0 as number | null, error: null as unknown },
  updateResult: { data: null as { id: string }[] | null, error: null as unknown },
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    from: (table: string) => {
      if (table !== "wallets") throw new Error(`unexpected table ${table}`);
      let mode: "count" | "update" = "count";
      const builder: Record<string, unknown> = {
        select: (_cols: string, opts?: { head?: boolean }) => {
          if (opts?.head) mode = "count";
          return builder;
        },
        update: () => {
          mode = "update";
          return builder;
        },
        is: () => builder,
        eq: () => builder,
        // Real supabase-js builders are thenable at every stage of the
        // chain, which is what lets `archiveWallet` await the count query
        // (terminated by `.eq`) and the UPDATE (terminated by `.select`)
        // without a distinct terminal method on either.
        then: (resolve: (v: unknown) => void) =>
          resolve(mode === "count" ? countResult : updateResult),
      };
      return builder;
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } } });
  // Three owned wallets, so the last-wallet guard is never what decides
  // any case below — each test is about the UPDATE's own outcome.
  countResult.count = 3;
  countResult.error = null;
  updateResult.data = [{ id: WALLET_ID }];
  updateResult.error = null;
});

describe("archiveWallet", () => {
  it("archives an owned wallet and revalidates the layout and /wallets", async () => {
    const result = await archiveWallet(WALLET_ID);

    expect(result).toEqual({});
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/wallets");
  });

  /**
   * The defect this test exists for. /wallets lists SHARED wallets, and
   * `archiveWallet`'s UPDATE is scoped `.eq("owner_id", user.id)` — so a
   * member archiving a wallet they do not own produces an UPDATE that
   * matches ZERO rows. Zero affected rows is not an error in Postgres, and
   * PostgREST reports none, so the action returned `{}` and the UI told
   * the user it had worked while nothing at all had changed.
   *
   * src/server/actions/categories.ts's `archiveCategory` is the in-repo
   * precedent: it selects the affected ids back and treats an empty result
   * as "not found" for exactly this reason.
   */
  it("returns an error rather than reporting success when the UPDATE matches no row", async () => {
    updateResult.data = [];

    const result = await archiveWallet(WALLET_ID);

    expect(result).toEqual({ error: "Wallet not found" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses to archive the caller's last OWNED wallet", async () => {
    countResult.count = 1;

    const result = await archiveWallet(WALLET_ID);

    expect(result).toEqual({
      error: "You need at least one wallet. Add another before archiving this one.",
    });
  });

  it("returns an error, never throws, when the UPDATE itself fails", async () => {
    updateResult.data = null;
    updateResult.error = { message: "boom", code: "XX000" };

    const result = await archiveWallet(WALLET_ID);

    // App-authored text, not the provider's — the module's own convention.
    expect(result).toEqual({ error: "Could not archive wallet. Please try again." });
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await archiveWallet(WALLET_ID);

    expect(result).toEqual({ error: "Not signed in" });
  });
});
