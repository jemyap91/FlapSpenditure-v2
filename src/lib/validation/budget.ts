import { z } from "zod";

/**
 * Digits with at most one decimal point, no sign — the same shape
 * `parseAmountInput` itself accepts (src/lib/money.ts). A budget is a cap, so
 * a leading "-" is meaningless here; rejecting it in the schema keeps the
 * error readable rather than letting parseAmountInput throw.
 */
const AMOUNT_SHAPE = /^\d+(\.\d+)?$/;

/**
 * The wallet set alone — what `updateBudgetWallets` (0027) takes, and the
 * set half of `budgetInput` below, so the two can never drift.
 *
 * At least one: an empty set satisfies budgets_visible's `not exists` for
 * every user (0013's HAZARD comment), so it is refused here, again in
 * set_budget / update_budget_wallets themselves, and ignored by
 * get_budget_status. Three layers because it fails OPEN.
 *
 * Elements are validated as `z.uuid()`, matching the convention
 * src/server/actions/categories.ts's own `idSchema` already established
 * (its comment records a prior review fix for exactly this: an untyped-
 * but-assumed-uuid id parameter left unvalidated). A malformed id is
 * caught HERE, before any Supabase client is constructed or any table is
 * touched — not left to surface one layer later as a generic
 * "could not save" after a round trip through the SQL function's own
 * `uuid[]` cast. That later layer still exists (defense in depth), but
 * this is the precise, pre-DB-call rejection.
 */
export const budgetWalletsInput = z.object({
  walletIds: z.array(z.uuid()).min(1, "Choose at least one wallet"),
});

export const budgetInput = budgetWalletsInput.extend({
  amount: z
    .string()
    .trim()
    .min(1, "Enter an amount")
    .regex(AMOUNT_SHAPE, "Enter an amount like 600 or 600.50"),
});

export type BudgetInput = z.infer<typeof budgetInput>;
