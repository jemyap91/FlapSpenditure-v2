/**
 * Month names, indexed 0-11, for labelling a `YYYY-MM-DD` string.
 *
 * This is a PLAIN module on purpose — no `"use client"`. Both tables lived in
 * `BudgetList.tsx` until a Server Component (`budgets/page.tsx`) needed one for
 * its heading, and importing a const from a client module across that boundary
 * fails in a way nothing catches: Next replaces every export of a client module
 * with a `registerClientReference` throwing function in the RSC layer, and
 * INDEXING that reference does not raise the friendly "called from the server"
 * error — it silently yields `undefined`. The heading rendered
 * `undefined 2026 · expenses only` in the real app while every unit test passed,
 * because vitest imports the real module and never reproduces the boundary.
 *
 * Importing a FUNCTION across that boundary is a loud error; importing a CONST
 * is a silent wrong value, which is worse. Keeping these here means neither
 * side has to think about it.
 *
 * Index from the string's own digits — `Number(iso.slice(5, 7)) - 1` — never
 * from a `Date`. `Date.toISOString()` shifts the day in any timezone ahead of
 * UTC, a bug this project has already fixed twice; see `month-range.ts`.
 */
export const MONTH_ABBREV = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Full names, for the page heading. Deliberately a second table rather than a
 * reuse of MONTH_ABBREV: the abbreviations exist for the cramped inline Remove
 * label (`Remove (set Aug)`), where brevity is the point. A heading is prose.
 */
export const MONTH_NAME = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
