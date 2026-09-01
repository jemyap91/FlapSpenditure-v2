/**
 * Today's date as `YYYY-MM-DD` in the caller's LOCAL calendar day, never
 * `new Date().toISOString()` — that is a UTC re-interpretation of a local
 * moment, and at 01:00 in Kuwait (UTC+3) it yields *yesterday's* date, which
 * is wrong wherever "today" means the user's own calendar day, not
 * Greenwich's.
 *
 * Read via LOCAL getters (`getFullYear`/`getMonth`/`getDate`) only, never
 * mixed with a UTC read of the same value — src/lib/month-range.ts documents
 * a shipped Critical bug from mixing those two directions on a single value.
 *
 * The single, canonical definition. Previously duplicated byte-for-byte: a
 * private `todayLocalDate()` inside `src/components/TransactionForm.tsx`
 * (seeding the add-transaction date field) and a private `todayLocal()`
 * inside `src/server/actions/recurring.ts` (`recordOccurrence`'s
 * is-this-actually-due check). Two divergent notions of "today" in one
 * ledger app is precisely the bug class this project has already been
 * bitten by twice (see month-range.ts's own history) — both call sites now
 * import this one function instead.
 *
 * On the SERVER (a Server Component, or a Server Function such as
 * `recordOccurrence`), this resolves in the SERVER's own timezone, not
 * necessarily the caller's — a request filed just after local midnight in
 * one but not the other can disagree about what day it is. That is a real,
 * known, out-of-scope limitation shared with `month-range.ts`, not solved
 * here.
 */
export function todayLocalDate(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
