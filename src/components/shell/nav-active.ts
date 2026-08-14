/**
 * Shared active-state predicate for Sidebar and TabBar. Extracted so the
 * logic is unit-tested once instead of drifting between two copies (same
 * reasoning as src/lib/supabase/public-paths.ts and
 * src/lib/supabase/auth-gate-matcher.ts staying framework-free and tested).
 *
 * A bare `pathname.startsWith(href)` check (what the brief's snippets did)
 * makes every nav item whose href is a prefix of another item's href active
 * at the same time: TabBar has both `/transactions` ("Activity") and
 * `/transactions/new` ("Add"); on `/transactions/new`,
 * `"/transactions/new".startsWith("/transactions")` is true, so both tabs
 * would render `aria-current="page"`.
 *
 * Fixed with two rules:
 *  1. A match requires an exact match or a segment boundary
 *     (`pathname === href` or `pathname.startsWith(href + "/")`), so
 *     `/transactions-archive` does not falsely match `/transactions` (the
 *     same prefix-collision class of bug public-paths.ts already guards
 *     against for auth routes).
 *  2. When more than one href in the same nav matches, only the *longest*
 *     matching href wins — so `/transactions/new` matching both
 *     `/transactions` and `/transactions/new` resolves to the latter.
 */
export function isActive(pathname: string, href: string, allHrefs: readonly string[]): boolean {
  const matches = (candidate: string) =>
    pathname === candidate || pathname.startsWith(candidate === "/" ? "//" : `${candidate}/`);

  if (!matches(href)) return false;

  const longestMatch = allHrefs
    .filter(matches)
    .reduce((longest, candidate) => (candidate.length > longest.length ? candidate : longest), "");

  return href === longestMatch;
}
