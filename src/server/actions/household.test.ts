// src/server/actions/household.test.ts
//
// Same mocking shape as budgets.test.ts: `@/lib/supabase/server` and
// `next/cache` are intercepted before the module loads, so these tests run
// the actions' real validation and mapping without a request scope.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setWalletSharing,
  inviteToHousehold,
  revokeHouseholdInvite,
  respondToHouseholdInvite,
  leaveHousehold,
  removeHouseholdMember,
} from "./household";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WALLET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MATE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INVITE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const { getUser, rpcCalls, rpcResult, revalidatePath } = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpcCalls: [] as { fn: string; args: unknown }[],
  rpcResult: { data: null as unknown, error: null as unknown },
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
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  rpcCalls.length = 0;
  rpcResult.data = null;
  rpcResult.error = null;
  getUser.mockResolvedValue({ data: { user: { id: USER, email: "me@x.io" } } });
});

const form = (email: string) => {
  const fd = new FormData();
  fd.set("email", email);
  return fd;
};

describe("setWalletSharing", () => {
  it("sends the whole row to set_wallet_sharing and revalidates both screens", async () => {
    const res = await setWalletSharing(WALLET, true, [MATE]);
    expect(res).toEqual({ notice: "Sharing updated." });
    expect(rpcCalls).toEqual([
      { fn: "set_wallet_sharing", args: { p_wallet: WALLET, p_household: true, p_direct: [MATE] } },
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/wallets");
    expect(revalidatePath).toHaveBeenCalledWith("/household");
  });
  it("rejects a malformed user id before any RPC", async () => {
    const res = await setWalletSharing(WALLET, false, ["nope"]);
    expect(res).toEqual({ error: "That person is not valid." });
    expect(rpcCalls).toEqual([]);
  });
  it("maps the household-only refusal to app copy", async () => {
    rpcResult.error = { message: "a wallet can only be shared with people in its household" };
    const res = await setWalletSharing(WALLET, false, [MATE]);
    expect(res).toEqual({ error: "You can only share a wallet with people in its household." });
  });
  it("maps any other refusal to a generic message", async () => {
    rpcResult.error = { message: "only the wallet owner can change who it is shared with" };
    const res = await setWalletSharing(WALLET, false, []);
    expect(res).toEqual({ error: "Could not update sharing. Please try again." });
    expect(JSON.stringify(res)).not.toContain("wallet owner");
  });
});

describe("inviteToHousehold", () => {
  it("normalises the address, calls invite_to_space, and reports it", async () => {
    const res = await inviteToHousehold(SPACE, {}, form(" Pat@X.io "));
    expect(res).toEqual({ notice: "Invitation sent to pat@x.io." });
    expect(rpcCalls).toEqual([{ fn: "invite_to_space", args: { p_space: SPACE, p_email: "pat@x.io" } }]);
    expect(revalidatePath).toHaveBeenCalledWith("/household");
  });
  it("refuses an invalid address before any RPC", async () => {
    const res = await inviteToHousehold(SPACE, {}, form("not-an-email"));
    expect(res).toEqual({ error: "Enter a valid email address" });
    expect(rpcCalls).toEqual([]);
  });
  it("refuses inviting yourself", async () => {
    const res = await inviteToHousehold(SPACE, {}, form("me@x.io"));
    expect(res).toEqual({ error: "You are already in this household." });
    expect(rpcCalls).toEqual([]);
  });
  it("maps a duplicate pending invite (23505) to readable copy", async () => {
    rpcResult.error = { code: "23505", message: "duplicate key value" };
    const res = await inviteToHousehold(SPACE, {}, form("pat@x.io"));
    expect(res).toEqual({ error: "There is already a pending invitation to that address." });
  });
  it("maps the already-a-member refusal", async () => {
    rpcResult.error = { message: "that person is already in this household" };
    const res = await inviteToHousehold(SPACE, {}, form("pat@x.io"));
    expect(res).toEqual({ error: "That person is already in this household." });
  });
});

describe("revokeHouseholdInvite / respondToHouseholdInvite", () => {
  it("revokes through the RPC", async () => {
    expect(await revokeHouseholdInvite(INVITE)).toEqual({});
    expect(rpcCalls).toEqual([{ fn: "revoke_space_invite", args: { p_invite: INVITE } }]);
  });
  it("accepts and declines through the right RPCs and revalidates the layout", async () => {
    await respondToHouseholdInvite(INVITE, true);
    await respondToHouseholdInvite(INVITE, false);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["accept_space_invite", "decline_space_invite"]);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
  it("returns an error, never throws, on refusal", async () => {
    rpcResult.error = { message: "invite is addressed to someone else" };
    expect(await respondToHouseholdInvite(INVITE, true)).toEqual({ error: "Could not respond to that invitation." });
  });
});

describe("leaveHousehold / removeHouseholdMember", () => {
  it("leaves and reports what moved", async () => {
    rpcResult.data = [{ wallets_moved: 2, budgets_moved: 1, budgets_trimmed: 1 }];
    const res = await leaveHousehold(SPACE);
    expect(res).toEqual({ notice: "You left the household. 2 wallets and 1 budget went with you; 1 budget lost a wallet." });
    expect(rpcCalls).toEqual([{ fn: "leave_space", args: { p_space: SPACE } }]);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
  it("removes and reports in the third person", async () => {
    rpcResult.data = [{ wallets_moved: 0, budgets_moved: 0, budgets_trimmed: 0 }];
    const res = await removeHouseholdMember(SPACE, MATE);
    expect(res).toEqual({ notice: "Removed from the household. 0 wallets and 0 budgets went with them; 0 budgets lost a wallet." });
    expect(rpcCalls).toEqual([{ fn: "remove_space_member", args: { p_space: SPACE, p_user: MATE } }]);
  });
  it("maps the owner-cannot-leave refusal", async () => {
    rpcResult.error = { message: "the household owner cannot leave" };
    expect(await leaveHousehold(SPACE)).toEqual({ error: "The household owner cannot leave." });
  });
  it("rejects malformed ids before any RPC", async () => {
    expect(await removeHouseholdMember("x", MATE)).toEqual({ error: "That household no longer exists." });
    expect(rpcCalls).toEqual([]);
  });
});
