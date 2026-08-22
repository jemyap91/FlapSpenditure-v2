// src/server/actions/invites.test.ts
//
// `./invites` carries a file-level "use server" and (transitively, through
// `@/lib/supabase/server`) reaches `next/headers` and `server-only` — this
// branch's binding rule says a unit test's import chain must never touch
// those with no `.env.local` present (`npm test` runs with none). `vi.mock`
// below intercepts BOTH `@/lib/supabase/server` and `next/cache` before the
// real modules ever load, so this suite exercises the three actions' actual
// logic — not a stand-in — while never constructing a real Supabase client
// or calling into Next's real cache-invalidation machinery (which throws
// outside a request scope).
//
// Spec §6 asks for "the three actions' validation and owner-only branches;
// the enumeration-safe invite response". All three are covered here.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { inviteToWallet, respondToInvite, removeMember } from "./invites";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WALLET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INVITE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/**
 * `vi.hoisted` is required because `vi.mock` factories are hoisted above
 * this file's own top-level `const`s — a plain closure over these below
 * would throw "Cannot access '...' before initialization" (see the same
 * note in src/components/TransactionList.test.tsx).
 *
 * The fake query builders deliberately do NOT replicate Postgres's
 * case-insensitive `uuid` equality — that behaviour lives in the database,
 * not in this mock. The bug the `removeMember` suite guards against is a
 * JS-level string comparison inside the action itself (`userId ===
 * wallet.owner_id`, evaluated before anything reaches Postgres), so the
 * fake `.eq()` calls are non-filtering RECORDERS that always resolve to
 * whatever `walletLookup`/`membersDelete` currently hold. What they record
 * is asserted on directly (`membersEqCalls`), alongside each action's
 * return value.
 *
 * `fromTables` and `rpcCalls` record every table and every RPC the action
 * touched. That is what makes the enumeration-safety test below a real
 * property test rather than two hand-written expectations that happen to
 * match today.
 */
const {
  getUser,
  walletLookup,
  membersDelete,
  membersEqCalls,
  invitesInsert,
  invitesInsertPayloads,
  rpcResult,
  rpcCalls,
  fromTables,
  revalidatePath,
} = vi.hoisted(() => ({
  getUser: vi.fn(),
  walletLookup: { data: null as { owner_id: string } | null, error: null as unknown },
  membersDelete: { error: null as unknown },
  membersEqCalls: [] as unknown[][],
  invitesInsert: { error: null as unknown },
  invitesInsertPayloads: [] as unknown[],
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
      if (table === "wallets") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => walletLookup,
        };
        return builder;
      }
      if (table === "wallet_invites") {
        const builder: Record<string, unknown> = {
          insert: (payload: unknown) => {
            invitesInsertPayloads.push(payload);
            return builder;
          },
          then: (resolve: (v: { error: unknown }) => void) => resolve(invitesInsert),
        };
        return builder;
      }
      if (table === "wallet_members") {
        const builder: Record<string, unknown> = {
          delete: () => builder,
          eq: (...args: unknown[]) => {
            membersEqCalls.push(["eq", ...args]);
            return builder;
          },
          // removeMember also chains .neq("user_id", wallet.owner_id) as a
          // database-level guard (defence in depth alongside the JS check).
          // The fake doesn't filter on it — it records it, so a test can
          // prove the guard is actually part of the statement rather than
          // taking the source comment's word for it.
          neq: (...args: unknown[]) => {
            membersEqCalls.push(["neq", ...args]);
            return builder;
          },
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

const inviteForm = (email: string) => {
  const fd = new FormData();
  fd.set("email", email);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  membersEqCalls.length = 0;
  invitesInsertPayloads.length = 0;
  rpcCalls.length = 0;
  fromTables.length = 0;
  walletLookup.data = { owner_id: OWNER_ID };
  walletLookup.error = null;
  membersDelete.error = null;
  invitesInsert.error = null;
  rpcResult.error = null;
});

describe("inviteToWallet", () => {
  it("rejects a malformed address before touching the database", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER_ID, email: "owner@x.io" } } });

    const result = await inviteToWallet(WALLET_ID, {}, inviteForm("not-an-email"));

    expect(result).toEqual({ error: "Enter a valid email address" });
    expect(fromTables).toEqual([]);
  });

  it("rejects inviting yourself", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER_ID, email: "owner@x.io" } } });

    const result = await inviteToWallet(WALLET_ID, {}, inviteForm("owner@x.io"));

    expect(result).toEqual({ error: "You are already in this account." });
    // Refused before the insert, not after it — a self-invite that reached
    // wallet_invites would sit there as a pending invitation the owner
    // could "accept" into a membership row they already hold.
    expect(invitesInsertPayloads).toEqual([]);
  });

  it("rejects inviting yourself under a different case or with padding", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER_ID, email: "owner@x.io" } } });

    // `inviteInput` trims and lower-cases before the comparison; without
    // that normalisation this would slip past the self-invite guard.
    const result = await inviteToWallet(WALLET_ID, {}, inviteForm("  OWNER@X.io  "));

    expect(result).toEqual({ error: "You are already in this account." });
    expect(invitesInsertPayloads).toEqual([]);
  });

  it("returns an error, never throws, when the insert is refused", async () => {
    // invites_owner RLS refuses a non-owner and wallet_invites_one_pending
    // refuses a duplicate; both arrive here as an insert error.
    getUser.mockResolvedValue({ data: { user: { id: MEMBER_ID, email: "member@x.io" } } });
    invitesInsert.error = { message: 'new row violates row-level security policy for table "wallet_invites"' };

    const result = await inviteToWallet(WALLET_ID, {}, inviteForm("someone@x.io"));

    // App-authored text. The raw provider string above names the table and
    // the policy; forwarding it is the leak this codebase's convention
    // exists to prevent.
    expect(result).toEqual({ error: "Could not send that invitation. Please try again." });
    expect(JSON.stringify(result)).not.toContain("row-level security");
  });

  it("tells the owner an invitation is already pending, rather than 'try again'", async () => {
    // Postgres 23505 on wallet_invites_one_pending. Observed in production:
    // the generic message told the user to retry, which is the one action
    // guaranteed to fail again for as long as the pending invite exists.
    getUser.mockResolvedValue({ data: { user: { id: OWNER_ID, email: "owner@x.io" } } });
    invitesInsert.error = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "wallet_invites_one_pending"',
    };

    const result = await inviteToWallet(WALLET_ID, {}, inviteForm("someone@x.io"));

    expect(result).toEqual({
      error: "There is already a pending invitation to that address for this account.",
    });
    // Still no raw provider text — the constraint name would leak schema.
    expect(JSON.stringify(result)).not.toContain("wallet_invites_one_pending");
  });

  it("does not leak registration status through the duplicate message", async () => {
    // The duplicate branch is safe to describe BECAUSE it reports only what
    // the owner already knows: that THEY invited this address to THEIR OWN
    // wallet. It says nothing about whether that address has an account, so
    // it does not reopen the enumeration oracle the generic message closes.
    getUser.mockResolvedValue({ data: { user: { id: OWNER_ID, email: "owner@x.io" } } });
    invitesInsert.error = { code: "23505", message: "duplicate key value" };

    const result = await inviteToWallet(WALLET_ID, {}, inviteForm("someone@x.io"));

    expect(JSON.stringify(result)).not.toMatch(/registered|account exists|no such user|unknown/i);
  });

  /**
   * ENUMERATION SAFETY (spec §3: "Returns the same shape whether or not the
   * address has an account, so the form cannot be used to test who is
   * registered").
   *
   * Asserting two hand-written expected objects match would prove nothing —
   * they would agree because this test wrote them both. The property that
   * actually holds is stronger and is what is asserted here:
   *
   *   1. The two responses are deeply equal to each other, for a registered
   *      and an unregistered address alike.
   *   2. `inviteToWallet` performs NO lookup that could distinguish the two
   *      in the first place. `fromTables` records every table the action
   *      touched; it must be exactly ["wallet_invites"], and `rpcCalls`
   *      must be empty. Adding a `profiles`/`auth.users` probe — or a
   *      definer function resolving email -> user_id — to give a registered
   *      address a different message would fail this test at that line,
   *      before anyone had to notice the two messages had drifted apart.
   */
  it("answers identically for a registered and an unregistered address, and cannot tell them apart", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER_ID, email: "owner@x.io" } } });

    // "registered@x.io" is, as far as this action can observe, an address
    // with an account; "nobody@x.io" has none. The action's behaviour is
    // identical because it never asks.
    const registered = await inviteToWallet(WALLET_ID, {}, inviteForm("registered@x.io"));
    const tablesForRegistered = [...fromTables];
    const rpcsForRegistered = [...rpcCalls];

    fromTables.length = 0;
    rpcCalls.length = 0;

    const unregistered = await inviteToWallet(WALLET_ID, {}, inviteForm("nobody@x.io"));

    // The notice necessarily echoes the address the user typed — that is
    // not a leak, they supplied it. Everything else must match, and neither
    // response may carry a hint of registration status.
    expect(Object.keys(registered)).toEqual(Object.keys(unregistered));
    expect(registered).toEqual({ notice: "Invitation sent to registered@x.io." });
    expect(unregistered).toEqual({ notice: "Invitation sent to nobody@x.io." });
    expect("error" in registered).toBe(false);
    expect("error" in unregistered).toBe(false);

    // The load-bearing half: no branch COULD have differed, because no
    // query distinguishing the two was ever issued.
    expect(tablesForRegistered).toEqual(["wallet_invites"]);
    expect(fromTables).toEqual(["wallet_invites"]);
    expect(rpcsForRegistered).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("stores the invited address normalised, and never accepts invited_by from the caller", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER_ID, email: "owner@x.io" } } });

    await inviteToWallet(WALLET_ID, {}, inviteForm("  Partner@X.IO "));

    expect(invitesInsertPayloads).toEqual([
      { wallet_id: WALLET_ID, invited_email: "partner@x.io", invited_by: OWNER_ID },
    ]);
  });

  it("returns an error when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await inviteToWallet(WALLET_ID, {}, inviteForm("someone@x.io"));

    expect(result).toEqual({ error: "Not signed in" });
  });
});

describe("respondToInvite", () => {
  it("calls accept_wallet_invite when accepting", async () => {
    getUser.mockResolvedValue({ data: { user: { id: MEMBER_ID, email: "member@x.io" } } });

    const result = await respondToInvite(INVITE_ID, true);

    expect(result).toEqual({});
    expect(rpcCalls).toEqual([{ fn: "accept_wallet_invite", args: { invite: INVITE_ID } }]);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/wallets");
  });

  it("calls decline_wallet_invite when declining", async () => {
    getUser.mockResolvedValue({ data: { user: { id: MEMBER_ID, email: "member@x.io" } } });

    const result = await respondToInvite(INVITE_ID, false);

    expect(result).toEqual({});
    // The two are NOT interchangeable: accepting inserts a wallet_members
    // row, declining must not. Asserting the exact function name is what
    // stops the boolean being wired to the wrong branch.
    expect(rpcCalls).toEqual([{ fn: "decline_wallet_invite", args: { invite: INVITE_ID } }]);
  });

  it("returns an error rather than throwing when the RPC refuses", async () => {
    // What accept_wallet_invite raises for an invite addressed to somebody
    // else (proven at the database level in supabase/tests/rls.sql).
    getUser.mockResolvedValue({ data: { user: { id: MEMBER_ID, email: "member@x.io" } } });
    rpcResult.error = { message: "invite is addressed to someone else", code: "P0001" };

    // A thrown error would reach the browser as an opaque digest in
    // production, so `await` must resolve, not reject.
    const result = await respondToInvite(INVITE_ID, true);

    expect(result).toEqual({ error: "Could not respond to that invitation." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not forward the raw provider message", async () => {
    getUser.mockResolvedValue({ data: { user: { id: MEMBER_ID, email: "member@x.io" } } });
    rpcResult.error = { message: "invite is addressed to someone else", code: "P0001" };

    const result = await respondToInvite(INVITE_ID, true);

    // The RPC's own text names the reason, which tells a caller probing
    // invite ids that the invite EXISTS and belongs to someone else.
    expect(JSON.stringify(result)).not.toContain("addressed to someone else");
  });

  it("returns an error when there is no session, without calling the RPC", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await respondToInvite(INVITE_ID, true);

    expect(result).toEqual({ error: "Not signed in" });
    expect(rpcCalls).toEqual([]);
  });
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

  /**
   * The JS-level owner guard above is not the only protection, and until
   * now nothing observed the other one. `removeMember` also chains
   * `.neq("user_id", wallet.owner_id)` onto the DELETE, so Postgres — which
   * compares as `uuid`, and therefore case-insensitively — refuses to match
   * the owner's row even if the JS comparison were ever wrong again.
   *
   * A comment claiming a database-level guard exists is not evidence that
   * it is still in the statement. This asserts the whole recorded chain, so
   * dropping the `.neq`, or reordering it away from `wallet.owner_id`, or
   * scoping the DELETE to the wrong columns, all fail here.
   */
  it("scopes the DELETE to the wallet and member AND excludes the owner at the database level", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } } });

    await removeMember(WALLET_ID, MEMBER_ID);

    expect(membersEqCalls).toEqual([
      ["eq", "wallet_id", WALLET_ID],
      ["eq", "user_id", MEMBER_ID],
      ["neq", "user_id", OWNER_ID],
    ]);
  });

  it("issues no DELETE at all when the caller is not the owner", async () => {
    getUser.mockResolvedValue({ data: { user: { id: MEMBER_ID } } });

    await removeMember(WALLET_ID, MEMBER_ID);

    expect(membersEqCalls).toEqual([]);
    expect(fromTables).toEqual(["wallets"]);
  });

  it("returns an error, never throws, when the DELETE fails", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } } });
    membersDelete.error = { message: "connection reset", code: "08006" };

    const result = await removeMember(WALLET_ID, MEMBER_ID);

    expect(result).toEqual({ error: "Could not remove that person. Please try again." });
  });
});
