/**
 * Pure helpers for showing refunds (spec 2026-09-30-refunds-design.md §3.2,
 * §4.3). No I/O: callers pass rows they already loaded.
 */

export type LedgerCategory = { name: string; color_slot: number; icon: string };

/** Minor units, all non-negative except `share`, which goes negative when
 *  friends paid back more than the expense (spec leaves this uncapped). */
export function repaymentSummary(expenseMinor: number, repaymentMinors: number[]) {
  const paid = Math.abs(expenseMinor);
  const repaid = repaymentMinors.reduce((sum, m) => sum + Math.abs(m), 0);
  return { paid, repaid, share: paid - repaid };
}

/** The category a ledger row shows: its own, or for a refund its expense's
 *  (a refund stores none — 0030's refund_shape). Null when the expense sits
 *  in a wallet the viewer cannot see (`repaid_expense` embeds as null). */
export function ledgerCategory(row: {
  kind: string;
  categories: LedgerCategory | null;
  repaid_expense?: { categories: LedgerCategory | null } | null;
}): LedgerCategory | null {
  if (row.kind === "refund") return row.repaid_expense?.categories ?? null;
  return row.categories;
}

/** What a refund row says it repaid: the expense's merchant, else its note. */
export function repaysLabel(row: {
  kind: string;
  repaid_expense?: { merchant: string | null; note: string | null } | null;
}): string | null {
  if (row.kind !== "refund" || !row.repaid_expense) return null;
  return row.repaid_expense.merchant?.trim() || row.repaid_expense.note?.trim() || null;
}
