import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterBar } from "./FilterBar";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/transactions",
}));

const CAT_GROCERIES = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CATEGORIES = [
  { id: CAT_GROCERIES, name: "Groceries" },
  { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", name: "Salary" },
];

/** The URL the last `router.replace` navigated to, parsed. */
function lastUrl(): URL {
  const href = replace.mock.calls.at(-1)?.[0] as string;
  return new URL(href, "http://localhost");
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("FilterBar", () => {
  it("offers a search box, a category select and a date range, pinned by name", () => {
    render(<FilterBar categories={CATEGORIES} filters={{}} total={0} shown={0} />);
    expect(screen.getByRole("searchbox", { name: "Search transactions" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Category" })).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByLabelText("To")).toBeInTheDocument();
  });

  it("reflects the current filters in its controls", () => {
    render(
      <FilterBar
        categories={CATEGORIES}
        filters={{ q: "ntuc", categoryId: CAT_GROCERIES, from: "2026-09-01", to: "2026-09-30" }}
        total={3}
        shown={3}
      />,
    );
    expect(screen.getByRole("searchbox", { name: "Search transactions" })).toHaveValue("ntuc");
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue(CAT_GROCERIES);
    expect(screen.getByLabelText("From")).toHaveValue("2026-09-01");
    expect(screen.getByLabelText("To")).toHaveValue("2026-09-30");
  });

  it("navigates with the search term after a pause, not on every keystroke", async () => {
    // Every keystroke would re-run the page's database query; a short
    // pause after typing is what turns a stream of letters into one search.
    vi.useFakeTimers();
    render(<FilterBar categories={CATEGORIES} filters={{}} total={0} shown={0} />);

    // `fireEvent`, not `userEvent.type`: user-event awaits real timers
    // between keystrokes and deadlocks under fake ones. Four successive
    // change events are the same shape the debounce sees from typing.
    const box = screen.getByRole("searchbox", { name: "Search transactions" });
    for (const typed of ["n", "nt", "ntu", "ntuc"]) {
      fireEvent.change(box, { target: { value: typed } });
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }
    expect(replace).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(lastUrl().searchParams.get("q")).toBe("ntuc");
  });

  it("navigates immediately when the category or a date changes, keeping the other filters", async () => {
    const user = userEvent.setup();
    render(<FilterBar categories={CATEGORIES} filters={{ q: "ntuc" }} total={1} shown={1} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Category" }), CAT_GROCERIES);
    expect(lastUrl().searchParams.get("category")).toBe(CAT_GROCERIES);
    expect(lastUrl().searchParams.get("q")).toBe("ntuc");

    // A second change BEFORE the page has re-rendered with the first (the
    // `filters` prop is still `{ q }` here) must build on the first, not
    // on the stale prop — otherwise changing a date right after the
    // category silently drops the category.
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    expect(lastUrl().searchParams.get("from")).toBe("2026-09-01");
    expect(lastUrl().searchParams.get("category")).toBe(CAT_GROCERIES);
  });

  it("omits a cleared filter from the URL rather than sending an empty value", async () => {
    const user = userEvent.setup();
    render(<FilterBar categories={CATEGORIES} filters={{ categoryId: CAT_GROCERIES }} total={1} shown={1} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Category" }), "");
    expect(lastUrl().searchParams.has("category")).toBe(false);
    expect(lastUrl().pathname).toBe("/transactions");
  });

  it("offers Clear filters only when something is set, linking to the bare route", () => {
    const { rerender } = render(<FilterBar categories={CATEGORIES} filters={{}} total={0} shown={0} />);
    expect(screen.queryByRole("link", { name: "Clear filters" })).not.toBeInTheDocument();

    rerender(<FilterBar categories={CATEGORIES} filters={{ q: "x" }} total={0} shown={0} />);
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/transactions");
  });

  it("says how many rows match, and when the page cap hides some of them", () => {
    const { rerender } = render(
      <FilterBar categories={CATEGORIES} filters={{ q: "x" }} total={38} shown={38} />,
    );
    expect(screen.getByRole("status", { name: "Filter results" })).toHaveTextContent("38 matching");

    rerender(<FilterBar categories={CATEGORIES} filters={{ q: "x" }} total={250} shown={100} />);
    expect(screen.getByRole("status", { name: "Filter results" })).toHaveTextContent("Showing the latest 100 of 250 matching");

    // Unfiltered and under the cap: nothing to say.
    rerender(<FilterBar categories={CATEGORIES} filters={{}} total={12} shown={12} />);
    expect(screen.getByRole("status", { name: "Filter results" })).toHaveTextContent("");
  });
});
