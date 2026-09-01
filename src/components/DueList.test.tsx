import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DueList } from "./DueList";
import { recordOccurrence, skipOccurrence } from "@/server/actions/recurring";
import type { DueRow } from "@/app/(app)/due-rows";

// `@/server/actions/recurring` is a "use server" module that imports
// `@/lib/supabase/server`, which throws at import time outside a configured
// environment — same reasoning as RecurringList.test.tsx's identical mock.
vi.mock("@/server/actions/recurring", () => ({
  recordOccurrence: vi.fn(),
  skipOccurrence: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(recordOccurrence).mockReset();
  vi.mocked(skipOccurrence).mockReset();
  vi.mocked(recordOccurrence).mockResolvedValue({});
  vi.mocked(skipOccurrence).mockResolvedValue({});
});

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
    const { container } = render(<DueList rows={[]} olderDropped={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one row per due occurrence", () => {
    render(
      <DueList
        rows={[row({ occurrenceOn: "2026-07-01" }), row({ occurrenceOn: "2026-08-01" })]}
        olderDropped={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Record Rent for 1 July" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record Rent for 1 August" })).toBeInTheDocument();
  });

  it("names Record and Skip after both the rule and the date, since several rows can carry the same verb", () => {
    render(<DueList rows={[row({ occurrenceOn: "2026-07-01" })]} olderDropped={false} />);
    expect(screen.getByRole("button", { name: "Record Rent for 1 July" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip Rent for 1 July" })).toBeInTheDocument();
  });

  it("calls recordOccurrence with the row's rule id and occurrence date", async () => {
    const user = userEvent.setup();
    render(<DueList rows={[row({ ruleId: "rule-9", occurrenceOn: "2026-07-01" })]} olderDropped={false} />);
    await user.click(screen.getByRole("button", { name: "Record Rent for 1 July" }));
    await waitFor(() => expect(recordOccurrence).toHaveBeenCalledWith("rule-9", "2026-07-01"));
  });

  it("calls skipOccurrence with the row's rule id and occurrence date", async () => {
    const user = userEvent.setup();
    render(<DueList rows={[row({ ruleId: "rule-9", occurrenceOn: "2026-07-01" })]} olderDropped={false} />);
    await user.click(screen.getByRole("button", { name: "Skip Rent for 1 July" }));
    await waitFor(() => expect(skipOccurrence).toHaveBeenCalledWith("rule-9", "2026-07-01"));
  });

  it("shows the error recordOccurrence returns, rather than throwing", async () => {
    vi.mocked(recordOccurrence).mockResolvedValue({ error: "This occurrence is already recorded." });
    const user = userEvent.setup();
    render(<DueList rows={[row()]} olderDropped={false} />);
    await user.click(screen.getByRole("button", { name: "Record Rent for 1 July" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("This occurrence is already recorded."),
    );
  });

  it("renders a blocked row's reason instead of its buttons", () => {
    render(
      <DueList
        rows={[row({ blockedReason: "This wallet has been archived." })]}
        olderDropped={false}
      />,
    );
    expect(screen.getByText("This wallet has been archived.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Skip/ })).not.toBeInTheDocument();
  });

  it("states when older occurrences were withheld, rather than implying the user is caught up", () => {
    render(<DueList rows={[row()]} olderDropped />);
    expect(screen.getByText(/older/i)).toBeInTheDocument();
  });

  it("says nothing about withheld occurrences when none were dropped", () => {
    render(<DueList rows={[row()]} olderDropped={false} />);
    expect(screen.queryByText(/withheld|not shown|weren.t shown/i)).not.toBeInTheDocument();
  });
});
