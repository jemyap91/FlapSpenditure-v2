import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CategoryBreakdown, buildSegments, pctOf, type BreakdownRow } from "./CategoryBreakdown";

/**
 * REVIEW-CAUGHT: the original submission had no test for this component at
 * all — every claim about the fold boundary, "Other" pluralisation, and
 * colour-by-slot was manual browser observation only. `TransactionList.
 * test.tsx` is this branch's precedent for a component test; unlike that
 * component, `CategoryBreakdown` is a plain function component (no
 * "use client", no hooks, no server actions to mock), so these tests need
 * no `vi.mock` at all — render() is enough.
 */

function row(overrides: Partial<BreakdownRow> & { category_id: string }): BreakdownRow {
  return {
    name: overrides.category_id,
    color_slot: 1,
    icon: "circle",
    total_minor: 100,
    ...overrides,
  };
}

describe("buildSegments — the fold boundary and pluralisation", () => {
  it("does not fold at exactly TOP_N (6) rows — no 'Other' entry", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ category_id: `c${i}`, color_slot: ((i % 8) + 1) }));
    const segments = buildSegments(rows);
    expect(segments).toHaveLength(6);
    expect(segments.some((s) => s.category_id === "other")).toBe(false);
  });

  it("folds starting at the 7th row — exactly one 'Other' entry, singular category", () => {
    const rows = Array.from({ length: 7 }, (_, i) => row({ category_id: `c${i}`, color_slot: ((i % 8) + 1) }));
    const segments = buildSegments(rows);
    expect(segments).toHaveLength(7); // 6 real + 1 "Other"
    const other = segments.find((s) => s.category_id === "other");
    expect(other).toBeDefined();
    expect(other!.name).toBe("Other (1 category)");
    expect(other!.color_slot).toBe(0); // synthetic, never a real category's slot
  });

  it("pluralises 'categories' once more than one row folds, and sums their totals", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row({ category_id: `c${i}`, total_minor: 1000 })),
      row({ category_id: "tail-1", total_minor: 30 }),
      row({ category_id: "tail-2", total_minor: 20 }),
    ];
    const segments = buildSegments(rows);
    const other = segments.find((s) => s.category_id === "other")!;
    expect(other.name).toBe("Other (2 categories)");
    expect(other.total_minor).toBe(50);
  });

  it("never folds when there are fewer than TOP_N rows", () => {
    const rows = [row({ category_id: "only-one" })];
    const segments = buildSegments(rows);
    expect(segments).toEqual(rows);
  });

  it("sorts the visible (non-'Other') segments by color_slot ascending, independent of spend rank", () => {
    // Deliberately spend-ranked in the OPPOSITE order of color_slot, so a
    // pass-through (no sort) would fail this assertion.
    const rows = [
      row({ category_id: "a", color_slot: 6, total_minor: 600 }),
      row({ category_id: "b", color_slot: 2, total_minor: 500 }),
      row({ category_id: "c", color_slot: 8, total_minor: 400 }),
      row({ category_id: "d", color_slot: 1, total_minor: 300 }),
    ];
    const segments = buildSegments(rows);
    expect(segments.map((s) => s.color_slot)).toEqual([1, 2, 6, 8]);
    // Every segment still carries its OWN row's true identity — sorting
    // reorders the array, it never reassigns a color_slot by position.
    expect(segments.find((s) => s.color_slot === 1)!.category_id).toBe("d");
    expect(segments.find((s) => s.color_slot === 8)!.category_id).toBe("c");
  });

  it("keeps 'Other' last regardless of slot sort (it has no real slot to sort by)", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row({ category_id: `c${i}`, color_slot: 8 - i, total_minor: 100 })),
      row({ category_id: "tail", total_minor: 10 }),
    ];
    const segments = buildSegments(rows);
    expect(segments.at(-1)!.category_id).toBe("other");
  });
});

describe("pctOf", () => {
  it("rounds to the nearest whole percent", () => {
    expect(pctOf(1, 3)).toBe(33);
    expect(pctOf(2, 3)).toBe(67);
  });

  it("returns 0 rather than dividing by zero when total is 0", () => {
    expect(pctOf(0, 0)).toBe(0);
  });
});

describe("CategoryBreakdown — rendering", () => {
  it("renders the empty state, not a folded/zero bar, when there are no rows", () => {
    render(<CategoryBreakdown rows={[]} currencyCode="USD" total={0} />);
    expect(screen.getByText("No spending recorded this month.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("colours each bar segment and table row from its OWN stored color_slot, never by position", () => {
    const rows = [
      row({ category_id: "big", name: "Big", color_slot: 3, total_minor: 900 }),
      row({ category_id: "small", name: "Small", color_slot: 1, total_minor: 100 }),
    ];
    render(<CategoryBreakdown rows={rows} currencyCode="USD" total={1000} />);

    const bar = screen.getByRole("img", { name: /Spending by category/ });
    // Sorted by slot ascending: Small (slot 1) then Big (slot 3).
    const segEls = Array.from(bar.children) as HTMLElement[];
    expect(segEls).toHaveLength(2);
    const firstSeg = segEls[0]!;
    const secondSeg = segEls[1]!;
    expect(firstSeg.style.background).toBe("var(--cat-1)");
    expect(secondSeg.style.background).toBe("var(--cat-3)");
    expect(firstSeg.title).toBe("Small: $1.00");
    expect(secondSeg.title).toBe("Big: $9.00");
  });

  it("gives every row a mini bar sized from the same total as the hero/big bar", () => {
    const rows = [row({ category_id: "only", total_minor: 250 })];
    render(<CategoryBreakdown rows={rows} currencyCode="USD" total={1000} />);
    // The mini-bar's inner fill: 250/1000 = 25%.
    const table = screen.getByRole("table");
    const fill = table.querySelector("td div div") as HTMLElement;
    expect(fill.style.width).toBe("25%");
  });

  it("never folds the TABLE, even when the bar folds the tail into 'Other'", () => {
    const rows = Array.from({ length: 9 }, (_, i) => row({ category_id: `c${i}`, name: `Cat ${i}` }));
    render(<CategoryBreakdown rows={rows} currencyCode="USD" total={900} />);
    // All 9 individual categories still appear as their own table row.
    rows.forEach((r) => expect(screen.getByText(r.name)).toBeInTheDocument());
    // But the bar only ever has 6 real segments + 1 "Other".
    const bar = screen.getByRole("img", { name: /Spending by category/ });
    expect(bar.children).toHaveLength(7);
  });
});
