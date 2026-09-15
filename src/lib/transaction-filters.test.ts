import { describe, expect, it } from "vitest";
import { parseTransactionFilters, ilikePattern, hasAnyFilter } from "./transaction-filters";

const CAT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("parseTransactionFilters", () => {
  it("returns no filters for empty params", () => {
    expect(parseTransactionFilters({})).toEqual({});
  });

  it("keeps a trimmed search term, a category id and a date range", () => {
    expect(
      parseTransactionFilters({ q: "  ntuc  ", category: CAT, from: "2026-09-01", to: "2026-09-30" }),
    ).toEqual({ q: "ntuc", categoryId: CAT, from: "2026-09-01", to: "2026-09-30" });
  });

  it("drops a blank search term and an over-long one is truncated, never rejected", () => {
    // A URL is not a form: a bad value should degrade to "unfiltered", not
    // to an error page.
    expect(parseTransactionFilters({ q: "   " })).toEqual({});
    expect(parseTransactionFilters({ q: "x".repeat(200) }).q).toHaveLength(120);
  });

  it("drops a category that is not a uuid", () => {
    expect(parseTransactionFilters({ category: "groceries" })).toEqual({});
    expect(parseTransactionFilters({ category: "" })).toEqual({});
  });

  it("drops a date that is not a real YYYY-MM-DD", () => {
    expect(parseTransactionFilters({ from: "2026-13-01" })).toEqual({});
    expect(parseTransactionFilters({ to: "01/09/2026" })).toEqual({});
    expect(parseTransactionFilters({ from: "2026-02-30" })).toEqual({});
  });

  it("drops BOTH dates when from is after to", () => {
    // Passing them through would query an empty window and render "no
    // matches" for a range that reads as a typo, not a choice.
    expect(parseTransactionFilters({ from: "2026-09-30", to: "2026-09-01" })).toEqual({});
  });

  it("takes only the first value of a repeated param", () => {
    expect(parseTransactionFilters({ q: ["rent", "other"] })).toEqual({ q: "rent" });
  });
});

describe("hasAnyFilter", () => {
  it("is false for no filters and true for any one", () => {
    expect(hasAnyFilter({})).toBe(false);
    expect(hasAnyFilter({ q: "a" })).toBe(true);
    expect(hasAnyFilter({ to: "2026-09-30" })).toBe(true);
  });
});

describe("ilikePattern", () => {
  it("wraps the term in wildcards and double quotes", () => {
    expect(ilikePattern("ntuc")).toBe('"%ntuc%"');
  });

  it("escapes LIKE wildcards in the term so they match literally", () => {
    // "100%" must match the note "100%", not everything starting "100".
    // LIKE wants `\%`; PostgREST decodes `\\` to `\` inside a quoted value,
    // so the wire form is `\\%` — two layers, innermost first.
    expect(ilikePattern("100%")).toBe('"%100\\\\%%"');
    expect(ilikePattern("a_b")).toBe('"%a\\\\_b%"');
  });

  it("escapes characters PostgREST would otherwise parse as syntax", () => {
    // Commas, dots and parentheses split an `.or()` filter string; double
    // quoting is PostgREST's own escape for them, and quotes/backslashes
    // inside the quoted value are backslash-escaped. A backslash in the
    // TERM is first LIKE-escaped (`\\`) and then each of those is
    // quote-escaped again (`\\\\`).
    expect(ilikePattern('a,b.c(d) "e" \\f')).toBe('"%a,b.c(d) \\"e\\" \\\\\\\\f%"');
  });
});
