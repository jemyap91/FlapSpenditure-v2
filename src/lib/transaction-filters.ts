import { z } from "zod";

/**
 * The /transactions filters, as carried in the URL (`?q=&category=&from=&to=`)
 * and applied in the DATABASE query, never in the browser: the page caps at
 * 100 rows, so filtering client-side would only ever search the latest
 * hundred. URL state also makes a filtered view reloadable and shareable.
 *
 * Parsing is LENIENT by design — a URL is not a form. A malformed value
 * (a category that is not a uuid, "2026-02-30", a range with from after
 * to) is dropped so the page renders unfiltered, never an error page for
 * a mistyped query string.
 */
export type TransactionFilters = {
  /** Trimmed search term, matched against merchant OR note. */
  q?: string;
  categoryId?: string;
  /** Inclusive `YYYY-MM-DD` bounds on `occurred_on`. */
  from?: string;
  to?: string;
};

export const SEARCH_MAX_LENGTH = 120;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  // A real calendar date, not just the right shape: `Date.UTC` rolls
  // "2026-02-30" over to March, so the round trip disagrees.
  .refine((s) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  });

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function parseTransactionFilters(params: RawParams): TransactionFilters {
  const out: TransactionFilters = {};

  const q = first(params.q)?.trim().slice(0, SEARCH_MAX_LENGTH);
  if (q) out.q = q;

  const category = z.uuid().safeParse(first(params.category));
  if (category.success) out.categoryId = category.data;

  const from = isoDate.safeParse(first(params.from));
  const to = isoDate.safeParse(first(params.to));
  // An inverted range reads as a typo, not a choice — dropping both is
  // more honest than querying an empty window and saying "no matches".
  if (from.success && to.success && from.data > to.data) return out;
  if (from.success) out.from = from.data;
  if (to.success) out.to = to.data;

  return out;
}

export function hasAnyFilter(f: TransactionFilters): boolean {
  return f.q !== undefined || f.categoryId !== undefined || f.from !== undefined || f.to !== undefined;
}

/**
 * A `%term%` pattern safe to place inside a PostgREST `.or()` filter string.
 *
 * Two escapes are layered here, innermost first:
 *  1. LIKE's own wildcards (`%`, `_`) and its escape character (`\`) are
 *     backslash-escaped so the term matches literally — "100%" must not
 *     match everything beginning "100".
 *  2. The whole value is double-quoted, PostgREST's own way of carrying
 *     `,` `.` `(` `)` `:` — which would otherwise be parsed as filter
 *     syntax — with `"` and `\` inside the quotes backslash-escaped.
 */
export function ilikePattern(term: string): string {
  const like = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  const quoted = like.replace(/[\\"]/g, (c) => `\\${c}`);
  return `"%${quoted}%"`;
}
