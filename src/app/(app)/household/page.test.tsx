// src/app/(app)/household/page.test.tsx
//
// The household screen derives membership and the sharing grid from five
// RLS-scoped reads, so what is worth pinning here is the SHAPE: the caller
// is marked, owners lead, a co-member's private wallet is simply absent
// (RLS never returns it, so the page must not invent it), and a user in two
// households gets two sections rather than one merged list. Interactive
// behaviour (invite, remove, leave, sharing) is HouseholdSection's own test.
//
// `@/lib/supabase/server` and `@/lib/supabase/current-user` are mocked
// before either loads, following budgets/page.test.tsx: their real
// implementations reach `next/headers`, which throws outside a request.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

const { getCurrentUserProfile, spacesData, membersData, walletsData, sharingData, invitesData } = vi.hoisted(() => ({
  getCurrentUserProfile: vi.fn(),
  spacesData: [] as { id: string; name: string }[],
  membersData: [] as { space_id: string; user_id: string; display_name: string; role: "owner" | "member" }[],
  walletsData: [] as {
    id: string; name: string; owner_id: string; shared_with_household: boolean; archived_at: string | null; space_id: string;
  }[],
  sharingData: [] as { wallet_id: string; user_id: string; via: "owner" | "household" | "direct" }[],
  invitesData: [] as { id: string; space_id: string; invited_email: string }[],
}));

vi.mock("@/lib/supabase/current-user", () => ({ getCurrentUserProfile }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string) => {
      if (fn === "get_space_members") return { data: membersData, error: null };
      if (fn === "get_wallet_sharing") return { data: sharingData, error: null };
      throw new Error(`unexpected rpc ${fn}`);
    },
    from: (table: string) => {
      if (table === "space_invites") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          then: (resolve: (v: { data: typeof invitesData; error: null }) => void) =>
            resolve({ data: invitesData, error: null }),
        };
        return builder;
      }
      const data = table === "spaces" ? spacesData : table === "wallets" ? walletsData : null;
      if (data === null) throw new Error(`unexpected table ${table}`);
      const builder = {
        select: () => builder,
        order: () => builder,
        then: (resolve: (v: { data: typeof data; error: null }) => void) => resolve({ data, error: null }),
      };
      return builder;
    },
  }),
}));

import HouseholdPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  spacesData.length = 0;
  membersData.length = 0;
  walletsData.length = 0;
  sharingData.length = 0;
  invitesData.length = 0;
  getCurrentUserProfile.mockResolvedValue({ id: "u-alice", theme: "system", base_currency: "SGD" });
});

describe("HouseholdPage", () => {
  it("lists the household's members with the caller marked and owners first", async () => {
    spacesData.push({ id: "s1", name: "alice household" });
    membersData.push(
      { space_id: "s1", user_id: "u-bob", display_name: "bob", role: "member" },
      { space_id: "s1", user_id: "u-alice", display_name: "alice", role: "owner" },
    );
    walletsData.push({ id: "w1", name: "Everyday", owner_id: "u-alice", shared_with_household: true, archived_at: null, space_id: "s1" });

    render(await HouseholdPage());

    expect(screen.getByRole("heading", { level: 1, name: "Household" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "alice household" })).toBeInTheDocument();

    const members = within(screen.getByRole("list", { name: "alice household members" })).getAllByRole("listitem");
    expect(members).toHaveLength(2);
    expect(members[0]).toHaveTextContent("alice");
    expect(members[0]).toHaveTextContent("(you)");
    expect(members[0]).toHaveTextContent("Owner");
    expect(members[1]).toHaveTextContent("bob");
    expect(members[1]).not.toHaveTextContent("(you)");
    expect(members[1]).toHaveTextContent("Member");
  });

  it("lists only the wallets RLS returned, flagging archived ones", async () => {
    spacesData.push({ id: "s1", name: "alice household" });
    membersData.push({ space_id: "s1", user_id: "u-alice", display_name: "alice", role: "owner" });
    walletsData.push(
      { id: "w1", name: "Everyday", owner_id: "u-alice", shared_with_household: true, archived_at: null, space_id: "s1" },
      { id: "w2", name: "Old card", owner_id: "u-alice", shared_with_household: false, archived_at: "2026-01-01T00:00:00Z", space_id: "s1" },
    );

    render(await HouseholdPage());

    const grid = screen.getByRole("table", { name: "Who can see which wallet" });
    const rows = within(grid).getAllByRole("row").slice(1); // drop header row
    expect(rows).toHaveLength(2);
    expect(screen.getByRole("row", { name: /Everyday/ })).not.toHaveTextContent("archived");
    expect(screen.getByRole("row", { name: /Old card/ })).toHaveTextContent("archived");
  });

  it("renders one section per household for a user who belongs to two", async () => {
    spacesData.push({ id: "s1", name: "alice household" }, { id: "s2", name: "carol household" });
    membersData.push(
      { space_id: "s1", user_id: "u-alice", display_name: "alice", role: "owner" },
      { space_id: "s2", user_id: "u-carol", display_name: "carol", role: "owner" },
      { space_id: "s2", user_id: "u-alice", display_name: "alice", role: "member" },
    );
    walletsData.push({ id: "w9", name: "Carol shared", owner_id: "u-carol", shared_with_household: true, archived_at: null, space_id: "s2" });

    render(await HouseholdPage());

    expect(screen.getByRole("heading", { level: 1, name: "Households" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "alice household" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "carol household" })).toBeInTheDocument();

    // Alice's own household has no wallets in this fixture; the grid must
    // be per-section, not page-wide.
    const own = screen.getByRole("heading", { level: 2, name: "alice household" }).closest("section")!;
    expect(within(own).getAllByRole("row")).toHaveLength(1); // header row only
    expect(screen.getByRole("row", { name: /Carol shared/ })).toBeInTheDocument();
    const carolMembers = within(screen.getByRole("list", { name: "carol household members" })).getAllByRole("listitem");
    expect(carolMembers[0]).toHaveTextContent("carol");
    expect(carolMembers[1]).toHaveTextContent("(you)");
  });

  it("scopes each section's sharing grid to that household's own wallets", async () => {
    spacesData.push({ id: "s1", name: "alice household" }, { id: "s2", name: "carol household" });
    membersData.push(
      { space_id: "s1", user_id: "u-alice", display_name: "alice", role: "owner" },
      { space_id: "s1", user_id: "u-bob", display_name: "bob", role: "member" },
      { space_id: "s2", user_id: "u-carol", display_name: "carol", role: "owner" },
      { space_id: "s2", user_id: "u-alice", display_name: "alice", role: "member" },
    );
    walletsData.push(
      { id: "w1", name: "Everyday", owner_id: "u-alice", shared_with_household: true, archived_at: null, space_id: "s1" },
      { id: "w9", name: "Carol shared", owner_id: "u-carol", shared_with_household: true, archived_at: null, space_id: "s2" },
    );
    // get_wallet_sharing() returns rows for every wallet the caller can see
    // across ALL of their households in one call — the page must filter
    // each section's slice down to that household's own wallet ids before
    // handing it to HouseholdSection.
    sharingData.push(
      { wallet_id: "w1", user_id: "u-bob", via: "direct" },
      { wallet_id: "w9", user_id: "u-alice", via: "direct" },
    );

    render(await HouseholdPage());

    const aliceSection = screen.getByRole("heading", { level: 2, name: "alice household" }).closest("section")!;
    const carolSection = screen.getByRole("heading", { level: 2, name: "carol household" }).closest("section")!;

    expect(within(aliceSection).getByText("bob · direct")).toBeInTheDocument();
    expect(within(aliceSection).queryByText("alice · direct")).not.toBeInTheDocument();

    expect(within(carolSection).getByText("alice · direct")).toBeInTheDocument();
    expect(within(carolSection).queryByText("bob · direct")).not.toBeInTheDocument();
  });
});
