// src/app/(app)/household/page.test.tsx
//
// The household screen is read-only and derives everything from three
// RLS-scoped reads, so what is worth pinning is the SHAPE: the caller is
// marked, owners lead, a co-member's private wallet is simply absent (RLS
// never returns it, so the page must not invent it), and a user in two
// households gets two sections rather than one merged list.
//
// `@/lib/supabase/server` and `@/lib/supabase/current-user` are mocked
// before either loads, following budgets/page.test.tsx: their real
// implementations reach `next/headers`, which throws outside a request.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

const { getCurrentUserProfile, spacesData, membersData, walletsData } = vi.hoisted(() => ({
  getCurrentUserProfile: vi.fn(),
  spacesData: [] as { id: string; name: string }[],
  membersData: [] as { space_id: string; user_id: string; display_name: string; role: "owner" | "member" }[],
  walletsData: [] as {
    id: string; name: string; currency_code: string; archived_at: string | null; space_id: string;
  }[],
}));

vi.mock("@/lib/supabase/current-user", () => ({ getCurrentUserProfile }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string) => {
      if (fn === "get_space_members") return { data: membersData, error: null };
      throw new Error(`unexpected rpc ${fn}`);
    },
    from: (table: string) => {
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
  getCurrentUserProfile.mockResolvedValue({ id: "u-alice", theme: "system", base_currency: "SGD" });
});

describe("HouseholdPage", () => {
  it("lists the household's members with the caller marked and owners first", async () => {
    spacesData.push({ id: "s1", name: "alice household" });
    membersData.push(
      { space_id: "s1", user_id: "u-bob", display_name: "bob", role: "member" },
      { space_id: "s1", user_id: "u-alice", display_name: "alice", role: "owner" },
    );
    walletsData.push({ id: "w1", name: "Everyday", currency_code: "SGD", archived_at: null, space_id: "s1" });

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
      { id: "w1", name: "Everyday", currency_code: "SGD", archived_at: null, space_id: "s1" },
      { id: "w2", name: "Old card", currency_code: "SGD", archived_at: "2026-01-01T00:00:00Z", space_id: "s1" },
    );

    render(await HouseholdPage());

    const wallets = within(screen.getByRole("list", { name: "alice household wallets" })).getAllByRole("listitem");
    expect(wallets).toHaveLength(2);
    expect(wallets[0]).toHaveTextContent("Everyday");
    expect(wallets[0]).not.toHaveTextContent("Archived");
    expect(wallets[1]).toHaveTextContent("Old card");
    expect(wallets[1]).toHaveTextContent("Archived");
  });

  it("renders one section per household for a user who belongs to two", async () => {
    spacesData.push({ id: "s1", name: "alice household" }, { id: "s2", name: "carol household" });
    membersData.push(
      { space_id: "s1", user_id: "u-alice", display_name: "alice", role: "owner" },
      { space_id: "s2", user_id: "u-carol", display_name: "carol", role: "owner" },
      { space_id: "s2", user_id: "u-alice", display_name: "alice", role: "member" },
    );
    walletsData.push({ id: "w9", name: "Carol shared", currency_code: "USD", archived_at: null, space_id: "s2" });

    render(await HouseholdPage());

    expect(screen.getByRole("heading", { level: 1, name: "Households" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "alice household" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "carol household" })).toBeInTheDocument();

    // Alice's own household has no wallets in this fixture; the empty state
    // must be per-section, not page-wide.
    const own = screen.getByRole("heading", { level: 2, name: "alice household" }).closest("section")!;
    expect(within(own).getByText("No wallets yet.")).toBeInTheDocument();
    const carols = within(screen.getByRole("list", { name: "carol household wallets" })).getAllByRole("listitem");
    expect(carols).toHaveLength(1);
    expect(carols[0]).toHaveTextContent("Carol shared");
    const carolMembers = within(screen.getByRole("list", { name: "carol household members" })).getAllByRole("listitem");
    expect(carolMembers[0]).toHaveTextContent("carol");
    expect(carolMembers[1]).toHaveTextContent("(you)");
  });
});
