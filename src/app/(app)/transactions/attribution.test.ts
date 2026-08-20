import { describe, expect, it } from "vitest";
import { resolveCreatedByNames, anyRowShared, type MemberRow } from "./attribution";

/**
 * Reproduces round-1 review's Critical finding: an account with ONE solo
 * wallet (self is the only member) and ONE shared wallet (self + Alex),
 * with a transaction on each, viewed on the same /transactions page.
 * `get_wallet_members()` returns a row for the solo wallet too — it
 * filters only on membership, not on member count — so a naive lookup
 * resolves the solo row's `created_by_name` to the caller's own name
 * instead of null the moment ANY shared-wallet row is also on the page.
 */
const self: MemberRow = { wallet_id: "solo-wallet", user_id: "self", display_name: "You" };
const sharedSelf: MemberRow = { wallet_id: "shared-wallet", user_id: "self", display_name: "You" };
const alex: MemberRow = { wallet_id: "shared-wallet", user_id: "alex", display_name: "Alex" };
const members = [self, sharedSelf, alex];

const soloRow = { id: "t-solo", wallet_id: "solo-wallet", created_by: "self" };
const sharedRow = { id: "t-shared", wallet_id: "shared-wallet", created_by: "alex" };

describe("resolveCreatedByNames — mixed solo + shared page", () => {
  it("names the author on the shared-wallet row", () => {
    const [, resolvedShared] = resolveCreatedByNames([soloRow, sharedRow], members);
    expect(resolvedShared!.created_by_name).toBe("Alex");
  });

  it("stays null on the solo-wallet row, even though the caller authored it and get_wallet_members() knows their name", () => {
    const [resolvedSolo] = resolveCreatedByNames([soloRow, sharedRow], members);
    expect(resolvedSolo!.created_by_name).toBeNull();
  });
});

describe("anyRowShared", () => {
  it("is true once any row's wallet has more than one member", () => {
    expect(anyRowShared([soloRow, sharedRow], members)).toBe(true);
  });

  it("is false when every row's wallet is solo", () => {
    expect(anyRowShared([soloRow], members)).toBe(false);
  });
});
