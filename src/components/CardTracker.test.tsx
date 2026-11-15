// src/components/CardTracker.test.tsx
//
// Home's "Card bonus" section (spec 4.6). Figures use USD so `formatMoney`
// renders the "$" the brief shows; SGD would render "SGD 310.00".
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CardTracker } from "./CardTracker";
import type { CardTrackerRow } from "@/server/card-tracker";

const row = (over: Partial<CardTrackerRow> = {}): CardTrackerRow => ({
  walletId: "w1",
  walletName: "Citi Rewards",
  currency: "USD",
  bonusChannel: "online",
  capMinor: 100000,
  from: "2026-10-19",
  to: "2026-11-18",
  spentMinor: 31000,
  remainingMinor: 69000,
  pace: "under",
  mismatchCount: 0,
  ...over,
});

describe("CardTracker", () => {
  it("shows the card, spend against max, cycle dates and what is left", () => {
    render(<CardTracker today="2026-11-05" rows={[row()]} />);
    expect(screen.getByRole("heading", { name: "Card bonus" })).toBeInTheDocument();
    expect(screen.getByText("Citi Rewards")).toBeInTheDocument();
    expect(screen.getByText("$310.00 / $1,000.00")).toBeInTheDocument();
    expect(screen.getByText(/19 Oct–18 Nov/)).toBeInTheDocument();
    expect(screen.getByText(/\$690\.00 left/)).toBeInTheDocument();
  });

  it("words a card with no channel as a min spend", () => {
    render(<CardTracker today="2026-11-05" rows={[row({ bonusChannel: null })]} />);
    expect(screen.getByText(/\$690\.00 to go/)).toBeInTheDocument();
  });

  it("says when a min spend is on pace or reached", () => {
    const { rerender } = render(<CardTracker today="2026-11-05" rows={[row({ bonusChannel: null, pace: "on_pace" })]} />);
    expect(screen.getByText(/on pace to hit min spend/)).toBeInTheDocument();
    rerender(<CardTracker today="2026-11-05" rows={[row({ bonusChannel: null, pace: "reached" })]} />);
    expect(screen.getByText(/min spend reached/)).toBeInTheDocument();
  });

  it("collapses a cycle inside one month to a single month name", () => {
    render(<CardTracker today="2026-11-05" rows={[row({ from: "2026-11-01", to: "2026-11-30" })]} />);
    expect(screen.getByText(/1–30 Nov/)).toBeInTheDocument();
  });

  it("says when the card is on pace to hit the max", () => {
    render(<CardTracker today="2026-11-05" rows={[row({ pace: "on_pace" })]} />);
    expect(screen.getByText(/on pace to hit max/)).toBeInTheDocument();
  });

  it("says max reached, and shows spend above the max as is", () => {
    render(
      <CardTracker today="2026-11-05" rows={[row({ pace: "reached", spentMinor: 108000, remainingMinor: 0 })]} />,
    );
    expect(screen.getByText(/max reached/)).toBeInTheDocument();
    expect(screen.getByText("$1,080.00 / $1,000.00")).toBeInTheDocument();
  });

  it("draws a progress bar named after the wallet", () => {
    render(<CardTracker today="2026-11-05" rows={[row()]} />);
    const bar = screen.getByRole("progressbar", { name: "Citi Rewards" });
    expect(bar).toHaveAttribute("aria-valuenow", "31000");
    expect(bar).toHaveAttribute("aria-valuemax", "100000");
  });

  it("caps the bar's value at the max", () => {
    render(<CardTracker today="2026-11-05" rows={[row({ pace: "reached", spentMinor: 108000, remainingMinor: 0 })]} />);
    expect(screen.getByRole("progressbar", { name: "Citi Rewards" })).toHaveAttribute(
      "aria-valuenow",
      "100000",
    );
  });

  it("links the no-bonus count to that wallet's cycle mismatches", () => {
    render(<CardTracker today="2026-11-05" rows={[row({ mismatchCount: 2 })]} />);
    expect(screen.getByText("2 no bonus")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^2 no bonus.*Citi Rewards/ })).toHaveAttribute(
      "href",
      "/transactions?wallet=w1&mismatch=1&from=2026-10-19&to=2026-11-18",
    );
  });

  it("links a card to the expenses that counted on its channel", () => {
    render(<CardTracker today="2026-11-05" rows={[row()]} />);
    expect(screen.getByRole("link", { name: "Citi Rewards: see counted transactions" })).toHaveAttribute(
      "href",
      "/transactions?wallet=w1&expenses=1&channel=online&from=2026-10-19&to=2026-11-18",
    );
  });

  it("links a min-spend card to all its expenses for the cycle", () => {
    render(<CardTracker today="2026-11-05" rows={[row({ bonusChannel: null })]} />);
    expect(screen.getByRole("link", { name: "Citi Rewards: see counted transactions" })).toHaveAttribute(
      "href",
      "/transactions?wallet=w1&expenses=1&from=2026-10-19&to=2026-11-18",
    );
  });

  it("shows no no-bonus link when nothing is mismatched", () => {
    render(<CardTracker today="2026-11-05" rows={[row({ mismatchCount: 0 })]} />);
    expect(screen.queryByRole("link", { name: /no bonus/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/no bonus/)).not.toBeInTheDocument();
  });

  it("renders nothing without rows", () => {
    const { container } = render(<CardTracker today="2026-11-05" rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("CardTracker — ranking details", () => {
  it("numbers the cards in the order given and shows days left in the cycle", () => {
    render(
      <CardTracker
        today="2026-11-05"
        rows={[row({ walletId: "a", walletName: "First" }), row({ walletId: "b", walletName: "Second" })]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/^1First/);
    expect(items[1]).toHaveTextContent(/^2Second/);
    // 5 Nov to 18 Nov, today included.
    expect(items[0]).toHaveTextContent("14 days");
  });

  it("flags a bonus card near its cap to avoid, in words", () => {
    render(<CardTracker today="2026-11-05" rows={[row({ spentMinor: 91250, remainingMinor: 8750 })]} />);
    expect(screen.getByText("Avoid")).toBeInTheDocument();
  });

  it("badges each card with its owner", () => {
    render(
      <CardTracker
        today="2026-11-05"
        rows={[row()]}
        people={{ w1: { key: "u-j", name: "Jeremy", initials: "J", color: "var(--cobalt)", tint: "var(--cobalt-tint)" } }}
      />,
    );
    expect(screen.getByRole("img", { name: "Jeremy" })).toBeInTheDocument();
  });
});
