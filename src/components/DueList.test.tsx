import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DueList } from "./DueList";
import { recordOccurrence, skipOccurrence, unskipOccurrence } from "@/server/actions/recurring";
import { formatMoney } from "@/lib/money";
import type { DueRow } from "@/app/(app)/due-rows";

// `@/server/actions/recurring` is a "use server" module that imports
// `@/lib/supabase/server`, which throws at import time outside a configured
// environment — same reasoning as RecurringList.test.tsx's identical mock.
vi.mock("@/server/actions/recurring", () => ({
  recordOccurrence: vi.fn(),
  skipOccurrence: vi.fn(),
  unskipOccurrence: vi.fn(),
}));

// `DueList` imports `shortDate` from `RecurringList.tsx` (fix round 1, I2:
// consolidating on one date formatter rather than keeping a second one
// here) — which also imports `RecurringForm`, which renders
// `CategoryPicker`. Same mock, for the identical reason, as
// RecurringList.test.tsx's own.
vi.mock("@/server/actions/categories", () => ({
  createCategory: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(recordOccurrence).mockReset();
  vi.mocked(skipOccurrence).mockReset();
  vi.mocked(unskipOccurrence).mockReset();
  vi.mocked(recordOccurrence).mockResolvedValue({});
  vi.mocked(skipOccurrence).mockResolvedValue({});
  vi.mocked(unskipOccurrence).mockResolvedValue({});
});

const TODAY = "2026-09-01";

// `Intl.NumberFormat` can pick a non-breaking space between "SGD" and the
// digits — matches `AmountKeypad.test.tsx`'s identical helper/comment: this
// normalizes both the rendered DOM text and the hand-computed expectation
// to a plain " ", so the comparison doesn't depend on which whitespace
// character Intl happened to choose.
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function row(overrides: Partial<DueRow> = {}): DueRow {
  return {
    ruleId: "rule-1",
    ruleName: "Rent",
    occurrenceOn: "2026-07-01",
    amountMinor: -150000,
    currencyCode: "SGD",
    walletName: "Everyday",
    blockedReason: null,
    ...overrides,
  };
}

describe("DueList", () => {
  it("renders nothing when there are no due rows", () => {
    // The dashboard is opened many times a day and most of those times
    // nothing is owed — no empty state, not even a "you're all caught up"
    // card.
    const { container } = render(<DueList rows={[]} olderDropped={false} today={TODAY} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one row per due occurrence", () => {
    render(
      <DueList
        rows={[row({ occurrenceOn: "2026-07-01" }), row({ occurrenceOn: "2026-08-01" })]}
        olderDropped={false}
        today={TODAY}
      />,
    );
    expect(screen.getByRole("button", { name: "Record Rent for 1 Jul" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record Rent for 1 Aug" })).toBeInTheDocument();
  });

  it("names Record and Skip after both the rule and the date, since several rows can carry the same verb", () => {
    render(<DueList rows={[row({ occurrenceOn: "2026-07-01" })]} olderDropped={false} today={TODAY} />);
    expect(screen.getByRole("button", { name: "Record Rent for 1 Jul" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip Rent for 1 Jul" })).toBeInTheDocument();
  });

  // Fix round 1, I2 (blocking): the 12-month lookback window is INCLUSIVE at
  // both ends, so a rule can legitimately offer two occurrences on the same
  // day-and-month a year apart (a monthly rule anchored exactly 12 months
  // back offers 13 occurrences; a yearly rule offers 2). Both used to render
  // "1 September" with no year, giving both Record buttons the identical
  // accessible name — this test would have thrown on `getByRole`'s
  // duplicate-match error before the fix.
  it("includes the year on a row whose date falls outside the current year, to keep same-day-and-month rows distinguishable", () => {
    render(
      <DueList
        rows={[row({ occurrenceOn: "2025-09-01" }), row({ occurrenceOn: "2026-09-01" })]}
        olderDropped={false}
        today={TODAY}
      />,
    );
    // Last year's occurrence states its year...
    expect(screen.getByRole("button", { name: "Record Rent for 1 Sep 2025" })).toBeInTheDocument();
    // ...this year's does not, since `today`'s own year needs no restating.
    expect(screen.getByRole("button", { name: "Record Rent for 1 Sep" })).toBeInTheDocument();
  });

  it("calls recordOccurrence with the row's rule id and occurrence date", async () => {
    const user = userEvent.setup();
    render(
      <DueList
        rows={[row({ ruleId: "rule-9", occurrenceOn: "2026-07-01" })]}
        olderDropped={false}
        today={TODAY}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Record Rent for 1 Jul" }));
    await waitFor(() => expect(recordOccurrence).toHaveBeenCalledWith("rule-9", "2026-07-01"));
  });

  it("calls skipOccurrence with the row's rule id and occurrence date", async () => {
    const user = userEvent.setup();
    render(
      <DueList
        rows={[row({ ruleId: "rule-9", occurrenceOn: "2026-07-01" })]}
        olderDropped={false}
        today={TODAY}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Skip Rent for 1 Jul" }));
    await waitFor(() => expect(skipOccurrence).toHaveBeenCalledWith("rule-9", "2026-07-01"));
  });

  it("shows the error recordOccurrence returns, rather than throwing", async () => {
    vi.mocked(recordOccurrence).mockResolvedValue({ error: "This occurrence is already recorded." });
    const user = userEvent.setup();
    render(<DueList rows={[row()]} olderDropped={false} today={TODAY} />);
    await user.click(screen.getByRole("button", { name: "Record Rent for 1 Jul" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("This occurrence is already recorded."),
    );
  });

  // Fix round 1, C1 (CRITICAL): `skipOccurrence` has no rule lookup and no
  // archived check — RLS scopes it through wallet MEMBERSHIP, which survives
  // archiving — so it succeeds regardless of why a row is blocked. This
  // codebase has no "restore" action for an archived wallet, so withholding
  // Skip on a blocked row left it with NO way to ever leave this list:
  // `dueOccurrences` regenerates it every reload, and a monthly rule mints a
  // new one every month on top. Only Record is withheld.
  it("renders a blocked row's reason ALONGSIDE Skip, withholding only Record", () => {
    render(
      <DueList
        rows={[row({ blockedReason: "This wallet has been archived." })]}
        olderDropped={false}
        today={TODAY}
      />,
    );
    expect(screen.getByText("This wallet has been archived.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Skip/ })).toBeInTheDocument();
  });

  it("still calls skipOccurrence for a blocked row", async () => {
    const user = userEvent.setup();
    render(
      <DueList
        rows={[row({ ruleId: "rule-9", occurrenceOn: "2026-07-01", blockedReason: "This wallet has been archived." })]}
        olderDropped={false}
        today={TODAY}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Skip Rent for 1 Jul" }));
    await waitFor(() => expect(skipOccurrence).toHaveBeenCalledWith("rule-9", "2026-07-01"));
  });

  // Fix round 1, small: an `aria-label` on the `<li>` used to REPLACE its
  // accessible content, dropping the amount (and wallet name) from what a
  // screen reader announces while stepping through the row. Deleting the
  // amount/wallet-name spans left this behaviour entirely unasserted before.
  it("renders each row's amount and wallet name as visible content, not just its buttons", () => {
    render(
      <DueList
        rows={[row({ amountMinor: -150000, currencyCode: "SGD", walletName: "Everyday" })]}
        olderDropped={false}
        today={TODAY}
      />,
    );
    expect(
      screen.getByText((_, el) => normalizeWhitespace(el?.textContent ?? "") === normalizeWhitespace(formatMoney(-150000, "SGD", { signed: true }))),
    ).toBeInTheDocument();
    expect(screen.getByText(/Everyday/)).toBeInTheDocument();
  });

  // Fix round 1, I4: spec §5 requires a link from the DUE section to
  // /recurring (the /transactions half already exists from Task 5).
  it("links to /recurring so a due rule can be paused or edited", () => {
    render(<DueList rows={[row()]} olderDropped={false} today={TODAY} />);
    expect(screen.getByRole("link", { name: "Manage" })).toHaveAttribute("href", "/recurring");
  });

  // Fix round 1, I3: `olderDropped` is true for EITHER the 12-month floor OR
  // the 24-occurrence cap (which binds routinely — spec §1.5), so wording
  // that names "12 months" specifically is wrong whenever the cap, not the
  // floor, is what withheld rows. The message must be cause-neutral.
  it("states when older occurrences were withheld, without claiming a specific cause", () => {
    render(<DueList rows={[row()]} olderDropped today={TODAY} />);
    expect(screen.getByText(/older occurrences/i)).toBeInTheDocument();
    expect(screen.queryByText(/12 months/i)).not.toBeInTheDocument();
  });

  // Fix round 1, I7: the previous matcher (`/withheld|not shown|weren.t
  // shown/i`) didn't match the actual rendered copy ("…aren't shown here.",
  // with a curly apostrophe) — making the notice render UNCONDITIONALLY
  // still passed. This matcher mirrors its own positive sibling above.
  it("says nothing about withheld occurrences when none were dropped", () => {
    render(<DueList rows={[row()]} olderDropped={false} today={TODAY} />);
    expect(screen.queryByText(/older occurrences/i)).not.toBeInTheDocument();
  });

  // Fix round 2, I2: Skip used to be one tap, unconfirmed and irreversible
  // from the app — `unskipOccurrence` existed and was tested, but nothing
  // outside its own test file ever called it. These three tests mirror
  // TransactionList.test.tsx's own delete/undo suite.
  describe("skip/undo", () => {
    it("a successful skip shows the undo affordance", async () => {
      const user = userEvent.setup();
      render(
        <DueList
          rows={[row({ ruleId: "rule-9", occurrenceOn: "2026-07-01" })]}
          olderDropped={false}
          today={TODAY}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Skip Rent for 1 Jul" }));

      expect(await screen.findByText("Rent skipped")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    });

    it("undo calls unskipOccurrence with the row's rule id and occurrence date", async () => {
      const user = userEvent.setup();
      render(
        <DueList
          rows={[row({ ruleId: "rule-9", occurrenceOn: "2026-07-01" })]}
          olderDropped={false}
          today={TODAY}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Skip Rent for 1 Jul" }));
      await user.click(await screen.findByRole("button", { name: "Undo" }));

      await waitFor(() => expect(unskipOccurrence).toHaveBeenCalledWith("rule-9", "2026-07-01"));
    });

    it("a successful undo clears the toast entirely", async () => {
      const user = userEvent.setup();
      render(<DueList rows={[row()]} olderDropped={false} today={TODAY} />);

      await user.click(screen.getByRole("button", { name: "Skip Rent for 1 Jul" }));
      await user.click(await screen.findByRole("button", { name: "Undo" }));

      // The toast's message text is gone once cleared; the visible box
      // (with Undo/Dismiss) unmounts along with it — same assertion shape
      // as TransactionList's identical "a successful undo clears the toast
      // entirely" test.
      await waitFor(() => expect(screen.queryByText("Rent skipped")).not.toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Dismiss notification" })).not.toBeInTheDocument();
    });

    it("keeps the toast (and its Undo) mounted once the row it was for is gone from `rows`, but drops the Due heading", async () => {
      // The exact hazard this component's own doc comment names: skipping
      // the LAST due row makes the parent's next render pass `rows={[]}`
      // (page.tsx's revalidation no longer includes a skipped occurrence)
      // on the very same beat the toast needs to appear on. `rerender`
      // stands in for that parent re-render — `DueList` owns no row state
      // of its own to fake this with internally.
      const user = userEvent.setup();
      const { rerender } = render(<DueList rows={[row()]} olderDropped={false} today={TODAY} />);

      await user.click(screen.getByRole("button", { name: "Skip Rent for 1 Jul" }));
      await screen.findByText("Rent skipped");

      rerender(<DueList rows={[]} olderDropped={false} today={TODAY} />);

      // An unconditional `if (rows.length === 0) return null` would unmount
      // the toast (and the undo it offers) the instant `rows` went empty.
      expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
      // The DUE heading itself is gone regardless — spec §5's "absent
      // entirely when nothing is due" — even though the toast is still on
      // screen.
      expect(screen.queryByRole("heading", { name: "Due" })).not.toBeInTheDocument();
    });

    it("a failed undo keeps the action available, relabelled Retry", async () => {
      vi.mocked(unskipOccurrence).mockResolvedValue({ error: "Could not undo the skip. Please try again." });
      const user = userEvent.setup();
      render(<DueList rows={[row()]} olderDropped={false} today={TODAY} />);

      await user.click(screen.getByRole("button", { name: "Skip Rent for 1 Jul" }));
      await user.click(await screen.findByRole("button", { name: "Undo" }));

      expect(await screen.findByText("Could not undo the skip. Please try again.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });
  });
});
