import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecurringList, describeSchedule, type RecurringRuleRow } from "./RecurringList";
import type { RecurInterval } from "@/lib/recurrence";

// `src/server/actions/recurring.ts` is a "use server" module that imports
// `@/lib/supabase/server`, which throws at import time outside a configured
// environment (`NEXT_PUBLIC_SUPABASE_URL` etc. — see src/lib/supabase/env.ts).
// `vi.mock` intercepts the import before the real module (and its env read)
// ever loads, matching WalletList.test.tsx's identical mock of
// `@/server/actions/wallets`.
vi.mock("@/server/actions/recurring", () => ({
  archiveRule: vi.fn(),
}));

// RecurringList's edit dialog renders RecurringForm, which renders
// CategoryPicker — see RecurringForm.test.tsx's identical mock/comment for
// why this one is needed too.
vi.mock("@/server/actions/categories", () => ({
  createCategory: vi.fn(),
}));

/**
 * Task 5's failing-tests step (task-5-brief.md). The four scenarios below
 * are copied near-verbatim from the brief; `rule()` is the factory the
 * brief's own snippet assumes exists but leaves for this file to define.
 *
 * `rule()`'s own parameters are camelCase, matching the brief's example
 * calls exactly (`rule({ intervalUnit: "monthly", anchorOn: ... })`) — but
 * `RecurringRuleRow` itself, the actual prop type RecurringList renders,
 * stays snake_case throughout, matching every other row type in this
 * codebase (WalletList's `WalletWithBalance`, TransactionList's `Row`).
 * `rule()` is the seam between the two, not evidence either one should
 * change to match the other.
 */
function rule(
  overrides: Partial<{
    id: string;
    name: string;
    kind: "expense" | "income";
    amountMinor: number;
    currencyCode: string;
    walletName: string;
    intervalUnit: RecurInterval;
    anchorOn: string;
    endsOn: string | null;
    categoryName: string | null;
    categoryIcon: string | null;
    colorSlot: number | null;
  }> = {},
): RecurringRuleRow {
  return {
    id: overrides.id ?? "rule-1",
    wallet_id: "wallet-1",
    wallet_name: overrides.walletName ?? "Everyday",
    name: overrides.name ?? "Rule",
    kind: overrides.kind ?? "expense",
    amount_minor: overrides.amountMinor ?? -500,
    currency_code: overrides.currencyCode ?? "USD",
    category_id: "cat-1",
    category_name: overrides.categoryName ?? "Bills",
    category_icon: overrides.categoryIcon ?? "circle",
    color_slot: overrides.colorSlot ?? 1,
    interval_unit: overrides.intervalUnit ?? "monthly",
    anchor_on: overrides.anchorOn ?? "2026-09-01",
    ends_on: overrides.endsOn ?? null,
  };
}

describe("describeSchedule", () => {
  it("describes a monthly rule by the ordinal day of its anchor", () => {
    expect(describeSchedule({ interval_unit: "monthly", anchor_on: "2026-09-01", ends_on: null })).toMatch(
      /monthly on the 1st/i,
    );
  });

  it("describes a fortnightly rule as every 2 weeks from its anchor", () => {
    expect(
      describeSchedule({ interval_unit: "fortnightly", anchor_on: "2026-09-03", ends_on: null }),
    ).toMatch(/every 2 weeks from 3 Sep/i);
  });

  it("describes a yearly rule by month and day, with no year", () => {
    const desc = describeSchedule({ interval_unit: "yearly", anchor_on: "2026-09-01", ends_on: null });
    expect(desc).toMatch(/yearly on 1 Sep/i);
    expect(desc).not.toMatch(/2026/);
  });

  it("states an end date with its year when the rule has one", () => {
    expect(
      describeSchedule({ interval_unit: "monthly", anchor_on: "2026-09-01", ends_on: "2027-01-01" }),
    ).toMatch(/until 1 Jan 2027/i);
  });

  it("says nothing about an end date when the rule has none", () => {
    expect(
      describeSchedule({ interval_unit: "monthly", anchor_on: "2026-09-01", ends_on: null }),
    ).not.toMatch(/until/i);
  });
});

describe("RecurringList", () => {
  it("describes each rule in words, not codes", () => {
    render(<RecurringList rules={[rule({ name: "Rent", intervalUnit: "monthly", anchorOn: "2026-09-01" })]} />);
    expect(screen.getByText("Rent")).toBeInTheDocument();
    expect(screen.getByText(/monthly on the 1st/i)).toBeInTheDocument();
  });

  it("states an end date when the rule has one, and says nothing when it does not", () => {
    const { unmount } = render(<RecurringList rules={[rule({ endsOn: "2027-01-01" })]} />);
    expect(screen.getByText(/until 1 Jan 2027/i)).toBeInTheDocument();
    unmount();
    render(<RecurringList rules={[rule({ endsOn: null })]} />);
    expect(screen.queryByText(/until/i)).not.toBeInTheDocument();
  });

  it("renders an empty state rather than an empty list", () => {
    render(<RecurringList rules={[]} />);
    expect(screen.getByText(/nothing recurring yet/i)).toBeInTheDocument();
  });

  it("names Pause after the rule it pauses", () => {
    // Several rows each render a Pause control; by visible text alone they
    // are indistinguishable to anyone navigating by accessible name.
    render(<RecurringList rules={[rule({ name: "Spotify" })]} />);
    expect(screen.getByRole("button", { name: "Pause Spotify" })).toBeInTheDocument();
  });

  it("does not render Edit when no bound action is supplied for a rule", () => {
    render(<RecurringList rules={[rule({ name: "Rent" })]} />);
    expect(screen.queryByRole("button", { name: "Edit Rent" })).not.toBeInTheDocument();
  });

  it("renders Edit only for rules with a bound action", () => {
    render(
      <RecurringList
        rules={[rule({ id: "a", name: "Rent" }), rule({ id: "b", name: "Spotify" })]}
        editActions={{ a: async () => ({}) }}
      />,
    );
    expect(screen.getByRole("button", { name: "Edit Rent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Spotify" })).not.toBeInTheDocument();
  });
});
