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
  // At least one: an empty set satisfies budgets_visible's `not exists` for
  // every user (0013's HAZARD comment), so it is refused here, again in
  // set_budget itself, and ignored by get_budget_status. Three layers
  // because it fails OPEN.
  //
  // Elements are validated as non-empty strings, not `z.uuid()`: the task
  // brief's own step-1 test asserts `walletIds: ["a"]` parses successfully,
  // which a `z.uuid()` element schema would reject, making that test
  // permanently red rather than a red-then-green TDD cycle. Format
  // validation is left to the database: a malformed id reaches `set_budget`
  // as a `uuid[]` argument, Postgres rejects the cast, and the action below
  // maps that failure to the same generic app-authored copy every other
  // `set_budget` refusal gets — so a bad id still can never reach a write,
  // it just fails one layer later than a `z.uuid()` element check would.
  walletIds: z.array(z.string().min(1)).min(1, "Choose at least one account"),
});

export type BudgetInput = z.infer<typeof budgetInput>;
