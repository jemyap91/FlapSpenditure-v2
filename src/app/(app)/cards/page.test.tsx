import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/current-user", () => ({
  getCurrentUserProfile: async () => ({ id: "u-c", theme: "system", base_currency: "SGD", wallet_sort: "manual" }),
}));

const { loadCardTracker, walletsData, walletsError } = vi.hoisted(() => ({
  loadCardTracker: vi.fn(),
  walletsData: [] as Record<string, unknown>[],
  walletsError: { value: null as { message: string } | null },
}));
vi.mock("@/server/card-tracker", () => ({ loadCardTracker }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string) => {
      if (name !== "get_space_members") throw new Error(`unexpected rpc ${name}`);
      return {
        data: [
          { space_id: "s1", user_id: "u-c", display_name: "Cheryl", role: "owner", joined_at: "2026-01-01" },
          { space_id: "s1", user_id: "u-j", display_name: "Jeremy", role: "member", joined_at: "2026-01-02" },
        ],
        error: null,
      };
    },
    from: (table: string) => {
      if (table !== "wallets") throw new Error(`unexpected table ${table}`);
      const builder: Record<string, unknown> = {
        select: () => builder,
        is: () => builder,
        eq: () => builder,
        order: () => builder,
        then: (resolve: (v: unknown) => void) =>
          resolve(walletsError.value ? { data: null, error: walletsError.value } : { data: walletsData, error: null }),
      };
      return builder;
    },
  }),
}));

import CardsPage from "./page";

const card = (over: Record<string, unknown>) => ({
  walletId: "w-yuu",
  walletName: "Yuu Card AMEX 0812 (C)",
  currency: "SGD",
  bonusChannel: null,
  capMinor: 80000,
  from: "2026-10-24",
  to: "2026-11-23",
  spentMinor: 54020,
  remainingMinor: 25980,
  pace: "under",
  mismatchCount: 0,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 18, 12, 0, 0));
  walletsError.value = null;
  walletsData.length = 0;
  walletsData.push(
    { id: "w-yuu", name: "Yuu Card AMEX 0812 (C)", kind: "card", owner_id: "u-c", shared_with_household: false },
    { id: "w-citi", name: "Citi Rewards 8616 (J)", kind: "card", owner_id: "u-j", shared_with_household: false },
    { id: "w-trust", name: "Trust Card 3083 (C)", kind: "card", owner_id: "u-c", shared_with_household: false },
  );
  loadCardTracker.mockResolvedValue([
    card({
      walletId: "w-citi",
      walletName: "Citi Rewards 8616 (J)",
      bonusChannel: "online",
      capMinor: 100000,
      spentMinor: 91250,
      remainingMinor: 8750,
      to: "2026-11-30",
    }),
    card({}),
  ]);
});

afterEach(() => vi.useRealTimers());

describe("CardsPage", () => {
  it("leads with the card to use next and why", async () => {
    render(await CardsPage());
    const hero = screen.getByRole("region", { name: "Use next for everyday spend" });
    expect(within(hero).getByText("Yuu Card AMEX")).toBeInTheDocument();
    expect(within(hero).getByText("•••• 0812")).toBeInTheDocument();
    expect(hero).toHaveTextContent("SGD 259.80 short of its SGD 800.00 min spend, 6 days left in the cycle.");
    expect(within(hero).getByRole("img", { name: "Cheryl" })).toBeInTheDocument();
  });

  it("ranks the min spend to chase above the card to avoid", async () => {
    render(await CardsPage());
    const list = screen.getByRole("region", { name: "Card bonus" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Yuu Card AMEX 0812 (C)");
    expect(items[1]).toHaveTextContent("Citi Rewards 8616 (J)");
    expect(within(items[1]!).getByText("Avoid")).toBeInTheDocument();
  });

  it("lists cards with no terms, with where to set them", async () => {
    render(await CardsPage());
    const other = screen.getByRole("region", { name: "Other cards" });
    expect(within(other).getByText("Trust Card 3083 (C)")).toBeInTheDocument();
    expect(within(other).getByRole("link", { name: "Set terms in Wallets" })).toHaveAttribute("href", "/wallets");
  });

  it("says so when every card is done", async () => {
    loadCardTracker.mockResolvedValue([card({ spentMinor: 80000, remainingMinor: 0, pace: "reached" })]);
    render(await CardsPage());
    expect(screen.getByText(/Every card has reached its target or cap/)).toBeInTheDocument();
  });

  it("fails rather than showing no cards when the read fails", async () => {
    walletsError.value = { message: "boom" };
    await expect(CardsPage()).rejects.toThrow("Failed to load cards");
  });
});
