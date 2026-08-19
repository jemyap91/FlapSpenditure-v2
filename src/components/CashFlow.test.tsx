import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CashFlow, barHeight, computeMaxMagnitude, MIN_BAR_PX, type FlowRow } from "./CashFlow";

/**
 * Added during this task's fix pass (review-caught: "add a test file," same
 * precedent `CategoryBreakdown.test.tsx` set). `CashFlow` is a plain function
 * component (no `"use client"`, no hooks, no server actions), so — like that
 * precedent — these tests need no `vi.mock` at all.
 */

function flowRow(overrides: Partial<FlowRow> & { bucket_start: string }): FlowRow {
  return { in_minor: 0, out_minor: 0, ...overrides };
}

describe("barHeight", () => {
  it("returns 0 for a true zero (no bar, not a floored sliver)", () => {
    expect(barHeight(0, 1000)).toBe(0);
  });

  it("returns 0 for a negative magnitude (defensive — the RPC never returns one)", () => {
    expect(barHeight(-5, 1000)).toBe(0);
  });

  it("floors a real, nonzero, sub-pixel value at MIN_BAR_PX rather than letting it round away", () => {
    // 1 / 1_000_000 * 88px is far under 1px — must not disappear.
    expect(barHeight(1, 1_000_000)).toBe(MIN_BAR_PX);
  });

  it("scales proportionally once above the floor", () => {
    // magnitude == maxMagnitude → the full 88px half-height.
    expect(barHeight(500, 500)).toBe(88);
    // half the max → half the half-height.
    expect(barHeight(250, 500)).toBe(44);
  });
});

describe("computeMaxMagnitude", () => {
  it("guards the all-zero month against a divide-by-zero (returns 1, not 0)", () => {
    const rows = [flowRow({ bucket_start: "2026-08-01" }), flowRow({ bucket_start: "2026-08-02" })];
    expect(computeMaxMagnitude(rows)).toBe(1);
  });

  it("is the max magnitude across BOTH directions and every bucket, not per-bucket/per-direction", () => {
    const rows = [
      flowRow({ bucket_start: "2026-08-01", in_minor: 100, out_minor: 900 }),
      flowRow({ bucket_start: "2026-08-02", in_minor: 500, out_minor: 50 }),
    ];
    // 900 (day 1's out) is the overall max, even though it's neither the
    // largest in-value nor from the same bucket as the largest out-value's
    // comparison would suggest in isolation.
    expect(computeMaxMagnitude(rows)).toBe(900);
  });
});

describe("CashFlow — rendering", () => {
  it("renders the empty state, not a zero-height chart, when there are no rows", () => {
    render(<CashFlow rows={[]} currencyCode="USD" />);
    expect(screen.getByText("No cash flow recorded this month.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders one continuous baseline rule spanning the chart, not one per bucket", () => {
    const rows = [
      flowRow({ bucket_start: "2026-08-01", in_minor: 100 }),
      flowRow({ bucket_start: "2026-08-02", out_minor: 50 }),
      flowRow({ bucket_start: "2026-08-03", in_minor: 20, out_minor: 20 }),
    ];
    render(<CashFlow rows={rows} currencyCode="USD" />);
    const chart = screen.getByRole("img", { name: /Cash flow by period/ });
    // Exactly one absolutely-positioned baseline element, a direct child of
    // the chart container — not one drawn inside each of the 3 columns
    // (review-caught: the original per-column version rendered as a dashed
    // line, 3 short segments, not a single rule).
    const baselineEls = Array.from(chart.children).filter(
      (el) => (el as HTMLElement).style.position === "absolute",
    );
    expect(baselineEls).toHaveLength(1);
    const baseline = baselineEls[0] as HTMLElement;
    expect(baseline.style.left).toBe("0px");
    expect(baseline.style.right).toBe("0px");
  });

  it("gives a bucket with ONLY an out-value a baseline to anchor against (the one-sided case)", () => {
    // Nothing renders an in-bar this bucket — the baseline is the only thing
    // that says "here is zero" for it.
    const rows = [flowRow({ bucket_start: "2026-08-05", out_minor: 100 })];
    render(<CashFlow rows={rows} currencyCode="USD" />);
    const chart = screen.getByRole("img", { name: /Cash flow by period/ });
    const baselineEls = Array.from(chart.children).filter(
      (el) => (el as HTMLElement).style.position === "absolute",
    );
    expect(baselineEls).toHaveLength(1);
  });

  it("puts the hover title on the full half-container, not the (possibly 2px) bar itself", () => {
    // A tiny magnitude relative to the max floors to MIN_BAR_PX (2px) —
    // the title must still cover the full 88px half so the hit area isn't
    // needle-thin.
    const rows = [flowRow({ bucket_start: "2026-08-01", in_minor: 1, out_minor: 1_000_000 })];
    render(<CashFlow rows={rows} currencyCode="USD" />);
    const inTitleEl = document.querySelector('[title^="2026-08-01: in"]') as HTMLElement;
    expect(inTitleEl).toBeTruthy();
    expect(inTitleEl.style.height).toBe("88px");
  });

  it("discloses wallet-currency exclusion the same way the hero caption does", () => {
    const rows = [flowRow({ bucket_start: "2026-08-01", in_minor: 100 })];
    const { rerender } = render(<CashFlow rows={rows} currencyCode="USD" />);
    expect(screen.queryByText("USD wallets only")).not.toBeInTheDocument();

    rerender(<CashFlow rows={rows} currencyCode="USD" hasExcludedWallets />);
    expect(screen.getByText("USD wallets only")).toBeInTheDocument();
  });

  it("renders an exactly-balanced bucket's Net as unsigned, not '+$0.00'", () => {
    const rows = [flowRow({ bucket_start: "2026-08-10", in_minor: 500, out_minor: 500 })];
    render(<CashFlow rows={rows} currencyCode="USD" />);
    const table = screen.getByRole("table");
    const netCell = table.querySelectorAll("tbody tr td")[3]!;
    expect(netCell.textContent).toBe("$0.00");
  });

  it("still signs a genuinely nonzero net", () => {
    const rows = [flowRow({ bucket_start: "2026-08-01", in_minor: 500, out_minor: 200 })];
    render(<CashFlow rows={rows} currencyCode="USD" />);
    const table = screen.getByRole("table");
    const netCell = table.querySelectorAll("tbody tr td")[3]!;
    expect(netCell.textContent).toBe("+$3.00");
  });

  it("never negates out_minor a second time — In/Out columns show the RPC's own positive magnitudes", () => {
    const rows = [flowRow({ bucket_start: "2026-08-01", in_minor: 12345, out_minor: 6789 })];
    render(<CashFlow rows={rows} currencyCode="USD" />);
    const table = screen.getByRole("table");
    const cells = table.querySelectorAll("tbody tr td");
    expect(cells[1]!.textContent).toBe("$123.45"); // In
    expect(cells[2]!.textContent).toBe("$67.89"); // Out — positive, not "-$67.89"
  });
});
