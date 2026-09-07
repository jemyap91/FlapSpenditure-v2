import { describe, it, expect } from "vitest";
import {
  merchantOptions,
  noteOptions,
  usualCategoryId,
  type EntrySuggestion,
} from "./entry-suggestions";

const rows: EntrySuggestion[] = [
  { merchant: "NTUC FairPrice", note: "Weekly shop", category_id: "cat-groceries", uses: 5, last_used: "2026-09-01" },
  { merchant: "NTUC FairPrice", note: "Snacks", category_id: "cat-groceries", uses: 2, last_used: "2026-08-20" },
  { merchant: "NTUC FairPrice", note: null, category_id: "cat-household", uses: 1, last_used: "2026-08-01" },
  { merchant: "Grab", note: "To work", category_id: "cat-transport", uses: 4, last_used: "2026-09-05" },
  { merchant: null, note: "Birthday gift", category_id: "cat-shopping", uses: 1, last_used: "2026-07-01" },
];

describe("merchantOptions", () => {
  it("lists each merchant once, most used first", () => {
    expect(merchantOptions(rows)).toEqual(["NTUC FairPrice", "Grab"]);
  });
  it("is empty with no suggestions", () => {
    expect(merchantOptions([])).toEqual([]);
  });
});

describe("noteOptions", () => {
  it("narrows to the typed merchant's own notes when it matches one, ignoring case and spaces", () => {
    expect(noteOptions(rows, "  ntuc fairprice ")).toEqual(["Weekly shop", "Snacks"]);
  });
  it("offers every note when the merchant box is empty or unknown", () => {
    expect(noteOptions(rows, "")).toEqual(["Weekly shop", "To work", "Snacks", "Birthday gift"]);
    expect(noteOptions(rows, "Somewhere new")).toEqual(["Weekly shop", "To work", "Snacks", "Birthday gift"]);
  });
});

describe("usualCategoryId", () => {
  it("returns the category used most with that merchant, summed across notes", () => {
    expect(usualCategoryId(rows, "NTUC FairPrice")).toBe("cat-groceries");
  });
  it("matches the merchant ignoring case and surrounding spaces", () => {
    expect(usualCategoryId(rows, " grab ")).toBe("cat-transport");
  });
  it("returns null for an unknown merchant or an empty box", () => {
    expect(usualCategoryId(rows, "Somewhere new")).toBeNull();
    expect(usualCategoryId(rows, "")).toBeNull();
  });
});
