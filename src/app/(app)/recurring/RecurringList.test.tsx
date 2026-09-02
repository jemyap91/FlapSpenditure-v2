import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecurringList, describeSchedule, type RecurringRuleRow } from "./RecurringList";
import { archiveRule } from "@/server/actions/recurring";
import type { RecurInterval } from "@/lib/recurrence";
import type { Category } from "@/components/CategoryPicker";

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

beforeEach(() => {
  vi.mocked(archiveRule).mockReset();
  vi.mocked(archiveRule).mockResolvedValue({});
});

/** A stand-in for a bound `updateRule`. RecurringList only needs
 *  SOMETHING action-shaped to render the form; what the action does is
 *  recurring.test.ts's subject, not this file's — same convention as
 *  WalletList.test.tsx's identical `noopAction`. */
const noopAction = async () => ({});

const WALLETS = [{ id: "wallet-1", name: "Everyday", currency_code: "USD" }];
const CATEGORIES: Category[] = [
  { id: "cat-1", name: "Bills", kind: "expense", color_slot: 1, icon: "circle", wallet_id: "wallet-1" },
];

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

  // Fix round 2, small finding: the weekly branch had no test of its own —
  // only fortnightly's identically-shaped sibling was covered.
  it("describes a weekly rule as every week from its anchor", () => {
    expect(
      describeSchedule({ interval_unit: "weekly", anchor_on: "2026-09-03", ends_on: null }),
    ).toMatch(/every week from 3 Sep/i);
  });

  // Fix round 2, small finding: `ordinal`'s 11/12/13 guard (`rem100 >= 11 &&
  // rem100 <= 13`) had no test — every existing case anchored on the 1st,
  // which the guard doesn't even apply to. Without the guard, `n % 10 === 1`
  // would say "monthly on the 11st".
  it.each([
    ["2026-09-11", "11th"],
    ["2026-09-12", "12th"],
    ["2026-09-13", "13th"],
    ["2026-09-21", "21st"],
  ])("ordinal-suffixes the anchor day correctly for the %s -> %s case", (anchor_on, suffix) => {
    expect(describeSchedule({ interval_unit: "monthly", anchor_on, ends_on: null })).toMatch(
      new RegExp(`monthly on the ${suffix}`, "i"),
    );
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

  /**
   * Fix round 1 (task-5-fix-1, Minor). `category_name` was fetched by
   * page.tsx, plumbed through this row type, and seeded in this file's own
   * `rule()` factory — but never rendered, so a user could not tell which
   * category a rule posts to without opening Edit.
   */
  it("shows which category a rule posts to", () => {
    render(<RecurringList rules={[rule({ name: "Rent", categoryName: "Housing" })]} />);
    expect(screen.getByText(/Housing/)).toBeInTheDocument();
  });
});

describe("RecurringList — edit dialog", () => {
  it("opens the Edit dialog seeded for that rule", async () => {
    const user = userEvent.setup();
    render(
      <RecurringList
        rules={[rule({ id: "a", name: "Rent", amountMinor: -500 }), rule({ id: "b", name: "Spotify" })]}
        wallets={WALLETS}
        categories={CATEGORIES}
        editActions={{ a: noopAction, b: noopAction }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit Rent" }));

    // The dialog's own name is the only thing identifying WHICH rule is
    // being changed once the row is behind a backdrop — same reasoning as
    // WalletList's identical dialog naming.
    expect(screen.getByRole("dialog", { name: "Edit Rent" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Rent");
    // Seeded from the RULE's own amount (500 minor units, USD -> "5.00"),
    // not left at the form's creation default of "0" — an unseeded form
    // here would mean the dialog opened on the right rule but forgot its
    // data.
    expect(screen.getByLabelText(/Amount/i)).toHaveValue("5.00");
  });

  it("closes the edit dialog once the save succeeds", async () => {
    const user = userEvent.setup();
    render(
      <RecurringList
        rules={[rule({ id: "a", name: "Rent" })]}
        wallets={WALLETS}
        categories={CATEGORIES}
        editActions={{ a: noopAction }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit Rent" }));
    expect(screen.getByRole("dialog", { name: "Edit Rent" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  /** The other half: a REJECTED save must leave the dialog open, or the
   *  user loses both the error message and everything they typed — same
   *  reasoning as WalletList's identical test. */
  it("keeps the edit dialog open when the save is refused", async () => {
    const user = userEvent.setup();
    render(
      <RecurringList
        rules={[rule({ id: "a", name: "Rent" })]}
        wallets={WALLETS}
        categories={CATEGORIES}
        editActions={{ a: async () => ({ error: "Name is required" }) }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit Rent" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByText("Name is required")).toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Edit Rent" })).toBeInTheDocument();
  });
});

describe("RecurringList — pause confirmation", () => {
  it("asks for confirmation before pausing, without calling archiveRule yet", async () => {
    const user = userEvent.setup();
    render(<RecurringList rules={[rule({ id: "a", name: "Spotify" })]} />);

    await user.click(screen.getByRole("button", { name: "Pause Spotify" }));

    expect(screen.getByRole("dialog", { name: "Pause Spotify?" })).toBeInTheDocument();
    expect(archiveRule).not.toHaveBeenCalled();
  });

  it("does nothing at all until the confirmation is accepted", async () => {
    const user = userEvent.setup();
    render(<RecurringList rules={[rule({ id: "a", name: "Spotify" })]} />);

    await user.click(screen.getByRole("button", { name: "Pause Spotify" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(archiveRule).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("pauses the rule once confirmed", async () => {
    const user = userEvent.setup();
    render(<RecurringList rules={[rule({ id: "a", name: "Spotify" })]} />);

    await user.click(screen.getByRole("button", { name: "Pause Spotify" }));
    // The dialog's own confirm button — plain "Pause", distinct from the
    // row's "Pause Spotify" by accessible name.
    await user.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(archiveRule).toHaveBeenCalledExactlyOnceWith("a"));
  });

  it("surfaces a failed pause through the list-level alert", async () => {
    vi.mocked(archiveRule).mockResolvedValue({ error: "Could not archive rule" });
    const user = userEvent.setup();
    render(<RecurringList rules={[rule({ id: "a", name: "Spotify" })]} />);

    await user.click(screen.getByRole("button", { name: "Pause Spotify" }));
    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not archive rule");
  });
});
