/**
 * Suggestions for the transaction form's Merchant and Note fields, derived
 * from `get_entry_suggestions()` (0026): one row per distinct (merchant,
 * note) pair the user has typed in the last twelve months, with how often
 * and the category most paired with it. These helpers turn that flat list
 * into what the form needs: the merchants to offer, the notes to offer for
 * a given merchant, and the category to prefill when a merchant is picked.
 *
 * Pure, so the form's behaviour is testable without rendering it. Matching
 * is case-insensitive and ignores surrounding whitespace, the same
 * normalisation the SQL applies, so what the user types lines up with what
 * was stored however it was spelled at the time.
 */
export type EntrySuggestion = {
  merchant: string | null;
  note: string | null;
  category_id: string | null;
  uses: number;
  last_used: string;
};

function key(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Aggregates rows by merchant, summing uses and keeping the latest date. */
function byMerchant(rows: EntrySuggestion[]) {
  const map = new Map<string, { merchant: string; uses: number; last_used: string }>();
  for (const r of rows) {
    if (!r.merchant) continue;
    const k = key(r.merchant);
    const cur = map.get(k);
    if (!cur) {
      map.set(k, { merchant: r.merchant, uses: r.uses, last_used: r.last_used });
    } else {
      cur.uses += r.uses;
      if (r.last_used > cur.last_used) cur.last_used = r.last_used;
    }
  }
  return map;
}

/** Each merchant once, most used first, then most recent. */
export function merchantOptions(rows: EntrySuggestion[]): string[] {
  return [...byMerchant(rows).values()]
    .sort((a, b) => b.uses - a.uses || b.last_used.localeCompare(a.last_used))
    .map((m) => m.merchant);
}

/**
 * Notes to offer. When the merchant box matches a known merchant, only the
 * notes used with it, most used first; otherwise every note, so an entry
 * with no merchant still gets its usual descriptions.
 */
export function noteOptions(rows: EntrySuggestion[], merchant: string): string[] {
  const k = key(merchant);
  const known = k !== "" && byMerchant(rows).has(k);
  const pool = known ? rows.filter((r) => key(r.merchant) === k) : rows;
  const seen = new Map<string, { note: string; uses: number; last_used: string }>();
  for (const r of pool) {
    if (!r.note) continue;
    const nk = key(r.note);
    const cur = seen.get(nk);
    if (!cur) seen.set(nk, { note: r.note, uses: r.uses, last_used: r.last_used });
    else {
      cur.uses += r.uses;
      if (r.last_used > cur.last_used) cur.last_used = r.last_used;
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.uses - a.uses || b.last_used.localeCompare(a.last_used))
    .map((n) => n.note);
}

/** The category used most with this merchant across all its notes, or null. */
export function usualCategoryId(rows: EntrySuggestion[], merchant: string): string | null {
  const k = key(merchant);
  if (k === "") return null;
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (key(r.merchant) !== k || !r.category_id) continue;
    totals.set(r.category_id, (totals.get(r.category_id) ?? 0) + r.uses);
  }
  let best: string | null = null;
  let bestUses = 0;
  for (const [id, uses] of totals) {
    if (uses > bestUses) {
      best = id;
      bestUses = uses;
    }
  }
  return best;
}
