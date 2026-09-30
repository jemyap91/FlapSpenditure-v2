/**
 * The four messages 0030_refunds.sql's triggers raise, and what a person
 * should read instead. Matched by equality on the full message, not by
 * substring: these strings are written by this codebase (0030), so an exact
 * match is both possible and the only way to be sure a DIFFERENT Postgres
 * error never gets relabelled. Anything unmapped returns null and the caller
 * keeps its own generic message (the "never forward raw provider text" rule,
 * src/server/actions/wallets.ts).
 */
const MESSAGES: Record<string, string> = {
  "this expense has repayments": "This expense has repayments. Delete them first.",
  "the repaid expense was deleted": "The expense this repaid was deleted.",
  "a repayment must repay an expense": "Expense not found",
  "a repayment must be in the expense's currency": "A repayment must be in the same currency as its expense.",
};

export function refundErrorMessage(dbMessage: string | undefined): string | null {
  return (dbMessage && MESSAGES[dbMessage]) || null;
}
