import { z } from "zod";

/**
 * Digits with at most one decimal point, no sign — the same shape
 * `parseAmountInput` itself accepts (src/lib/money.ts). A budget is a cap, so
 * a leading "-" is meaningless here; rejecting it in the schema keeps the
 * error readable rather than letting parseAmountInput throw.
 */
const AMOUNT_SHAPE = /^\d+(\.\d+)?$/;

export const budgetInput = z.object({
  amount: z
    .string()
    .trim()
    .min(1, "Enter an amount")
    .regex(AMOUNT_SHAPE, "Enter an amount like 600 or 600.50"),
});

export type BudgetInput = z.infer<typeof budgetInput>;
