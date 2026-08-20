// src/server/actions/invites.test.ts
//
// `./invites` carries a file-level "use server" and (transitively, through
// `@/lib/supabase/server`) reaches `next/headers` and `server-only` — this
// branch's binding rule says a unit test's import chain must never touch
// those with no `.env.local` present (`npm test` runs with none). `vi.mock`
// below intercepts BOTH `@/lib/supabase/server` and `next/cache` before the
// real modules ever load, so this suite exercises `removeMember`'s actual
// logic — not a stand-in — while never constructing a real Supabase client
// or calling into Next's real cache-invalidation machinery (which throws
// outside a request scope).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { removeMember } from "./invites";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WALLET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * `vi.hoisted` is required because `vi.mock` factories are hoisted above
 * this file's own top-level `const`s — a plain closure over these below
 * would throw "Cannot access '...' before initialization" (see the same
 * note in src/components/TransactionList.test.tsx).
 *
 * The fake query builders deliberately do NOT replicate Postgres's
 * case-insensitive `uuid` equality — that behaviour lives in the database,
 * not in this mock. The bug this suite guards against is a JS-level string
 * comparison inside `removeMember` itself (`userId === wallet.owner_id`,
 * evaluated before anything reaches Postgres), so the fake `.eq()` calls
 * are non-filtering recorders that always resolve to whatever
 * `walletLookup`/`membersDelete` currently hold — the test asserts on
 * `removeMember`'s *return value*, which is exactly what the guard
 * controls.
 */
const { getUser, walletLookup, membersDelete, membersEqCalls, revalidatePath } = vi.hoisted(
  () => ({
    getUser: vi.fn(),
    walletLookup: { data: null as { owner_id: string } | null, error: null as unknown },
    membersDelete: { error: null as unknown },
    membersEqCalls: [] as unknown[][],
    revalidatePath: vi.fn(),
  }),
);

vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    from: (table: string) => {
      if (table === "wallets") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => walletLookup,
        };
        return builder;
      }
      if (table === "wallet_members") {
        const builder: Record<string, unknown> = {
          delete: () => builder,
          eq: (...args: unknown[]) => {
            membersEqCalls.push(args);
            return builder;
          },
          // removeMember also chains .neq("user_id", wallet.owner_id) as a
          // database-level guard (defence in depth alongside the JS check
          // above) — the fake doesn't need to filter on it, only support
          // being called in the chain.
          neq: () => builder,
          // Real supabase-js query builders are thenable (awaiting the
          // builder itself resolves the request) — `removeMember` relies on
          // that (`await supabase.from(...).delete().eq(...).eq(...)`), so
          // the fake needs a `.then`, not a terminal method call.
          then: (resolve: (v: { error: unknown }) => void) => resolve(membersDelete),
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  membersEqCalls.length = 0;
  walletLookup.data = { owner_id: OWNER_ID };
  walletLookup.error = null;
  membersDelete.error = null;
});

describe("removeMember", () => {
  it("refuses to remove the owner when their id is passed exactly as stored", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } } });

    const result = await removeMember(WALLET_ID, OWNER_ID);

    expect(result).toEqual({ error: "The owner cannot be removed." });
  });

  // Regression test: `wallet.owner_id` arrives from Postgres already
  // lower-cased, but a client-supplied `userId` is never normalised before
  // this. A bare `userId === wallet.owner_id` lets an uppercased copy of
  // the owner's own id sail past the guard — Postgres's `uuid` type
  // equality is case-insensitive so the DELETE would still hit the row in
  // production, but this mock's `.eq()` doesn't filter, so the observable
  // symptom here is simpler and just as damning: the action returns `{}`
  // (success) instead of refusing, meaning it proceeded straight to the
  // delete call.
  it("refuses to remove the owner even when their id is passed uppercased", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } } });

    const result = await removeMember(WALLET_ID, OWNER_ID.toUpperCase());

    expect(result).toEqual({ error: "The owner cannot be removed." });
  });

  it("refuses a non-owner caller", async () => {
    getUser.mockResolvedValue({ data: { user: { id: MEMBER_ID } } });

    const result = await removeMember(WALLET_ID, MEMBER_ID);

    expect(result).toEqual({ error: "Only the account owner can do that." });
  });

  it("removes a legitimate member and revalidates both the layout and /wallets", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } } });

    const result = await removeMember(WALLET_ID, MEMBER_ID);

    expect(result).toEqual({});
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/wallets");
  });
});
