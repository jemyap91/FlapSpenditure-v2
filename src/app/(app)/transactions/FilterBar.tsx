"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { hasAnyFilter, type TransactionFilters } from "@/lib/transaction-filters";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";
const FIELD = `rounded-md border px-3 py-2 text-sm ${FOCUS_RING}`;
const FIELD_STYLE = { borderColor: "var(--ink-2)", background: "var(--surface)", color: "var(--ink)" };

/** How long typing must pause before the search navigates. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The /transactions filter controls. Owns no data: every change is written
 * to the URL (`router.replace`, so filtering does not pile up history
 * entries) and the Server Component page re-queries from it — see
 * `src/lib/transaction-filters.ts` for why the filters are applied in the
 * database and not here.
 *
 * The search box is debounced; the select and the two dates navigate on
 * change. A cleared control is REMOVED from the URL, not sent as an empty
 * value, so a bare `/transactions` is the one canonical unfiltered URL.
 */
export function FilterBar({
  categories,
  filters,
  /** Rows matching the current filters, across the whole table. */
  total,
  /** Rows actually on the page — at most the page cap. */
  shown,
}: {
  /** Active categories the viewer can see, each with its household's name. */
  categories: { id: string; name: string; household: string }[];
  filters: TransactionFilters;
  total: number;
  shown: number;
}) {
  const router = useRouter();
  const households = Array.from(new Set(categories.map((c) => c.household)));
  const pathname = usePathname();
  const searchId = useId();
  const categoryId = useId();
  const fromId = useId();
  const toId = useId();

  // Local only for the debounced search box: the other controls are
  // driven straight from `filters`, which the page re-derives from the URL
  // on every navigation.
  const [q, setQ] = useState(filters.q ?? "");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  // The filters as LAST NAVIGATED TO, not as last rendered: `filters` only
  // catches up once the server re-renders, so a second change made before
  // then (a date right after the category) would otherwise merge onto the
  // stale prop and silently drop the first. Re-synced whenever a fresh
  // prop does arrive.
  const latest = useRef(filters);
  useEffect(() => {
    latest.current = filters;
  }, [filters]);

  function navigate(patch: Partial<TransactionFilters>) {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    const params = new URLSearchParams();
    if (next.q) params.set("q", next.q);
    if (next.categoryId) params.set("category", next.categoryId);
    if (next.from) params.set("from", next.from);
    if (next.to) params.set("to", next.to);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  function handleSearch(value: string) {
    setQ(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      navigate({ q: value.trim() || undefined });
    }, SEARCH_DEBOUNCE_MS);
  }

  const filtered = hasAnyFilter(filters);
  const capped = shown < total;
  const summary = capped
    ? `Showing the latest ${shown} of ${total} matching`
    : filtered
      ? `${total} matching`
      : "";

  return (
    <div className="flex flex-col gap-2 px-4 pb-3">
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={searchId} className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Search transactions
          </span>
          <input
            id={searchId}
            type="search"
            value={q}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Merchant or note"
            autoComplete="off"
            className={FIELD}
            style={FIELD_STYLE}
          />
        </label>
        <label htmlFor={categoryId} className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Category
          </span>
          <select
            id={categoryId}
            value={filters.categoryId ?? ""}
            onChange={(e) => navigate({ categoryId: e.target.value || undefined })}
            className={FIELD}
            style={FIELD_STYLE}
          >
            <option value="">All categories</option>
            {households.length > 1
              ? // Every household seeds the same default names, so a viewer
                // in two of them would see "Groceries" twice with nothing
                // to tell them apart. Grouped by household only when there
                // is more than one: the common case stays a flat list.
                households.map((h) => (
                  <optgroup key={h} label={h}>
                    {categories
                      .filter((c) => c.household === h)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </optgroup>
                ))
              : categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
          </select>
        </label>
        <label htmlFor={fromId} className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            From
          </span>
          <input
            id={fromId}
            type="date"
            value={filters.from ?? ""}
            max={filters.to}
            onChange={(e) => navigate({ from: e.target.value || undefined })}
            className={FIELD}
            style={FIELD_STYLE}
          />
        </label>
        <label htmlFor={toId} className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            To
          </span>
          <input
            id={toId}
            type="date"
            value={filters.to ?? ""}
            min={filters.from}
            onChange={(e) => navigate({ to: e.target.value || undefined })}
            className={FIELD}
            style={FIELD_STYLE}
          />
        </label>
      </div>
      <div className="flex items-center justify-between gap-3">
        {/* Always mounted so a change in the count is announced, and so
            the row never jumps when the text appears. */}
        <p role="status" aria-label="Filter results" className="text-xs" style={{ color: "var(--ink-2)" }}>
          {summary}
        </p>
        {filtered && (
          <Link
            href={pathname}
            className={`shrink-0 rounded-sm text-xs underline ${FOCUS_RING}`}
            style={{ color: "var(--ink-2)" }}
          >
            Clear filters
          </Link>
        )}
      </div>
    </div>
  );
}
