import { test, expect, type Page } from "@playwright/test";

/**
 * Task 6's end-to-end proof of the feature's defining requirement, in the
 * requester's own words: "budgets should only register for expenses.
 * income and transfers shouldn't be included." Everything else in this
 * file is supporting cast for that one sentence, which must be proven in a
 * real browser, not only in SQL (supabase/tests — the RLS/constraints
 * suites — never exercise `get_budget_status` at all).
 *
 * Runs against the LOCAL Supabase stack, same as e2e/ledger.spec.ts — see
 * that file's own doc comment for the confirmations-disabled signup flow
 * this relies on. Helpers below are deliberately shaped like that file's
 * (`signUpAndOnboard`, `pressAmount`, `addWallet`) rather than imported
 * from it, matching how that file is itself a single self-contained spec
 * with no shared helper module.
 */

const PASSWORD = "test-password-123";
let n = 0;
const uniqueEmail = () => `budget-${Date.now()}-${n++}@example.com`;

/**
 * Identical shape to ledger.spec.ts's own helper: signs up a fresh user,
 * completes onboarding with one wallet, and lands on the dashboard. Every
 * test starts here — there is no shared/seeded E2E account.
 */
async function signUpAndOnboard(page: Page, walletName = "Everyday"): Promise<string> {
  const user = uniqueEmail();

  await page.goto("/signup");
  await page.getByLabel("Email").fill(user);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Add your first account" })).toBeVisible();
  await page.getByLabel("Name").fill(walletName);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL("/");
  return user;
}

/**
 * Adds a SECOND wallet from /wallets — the only screen that can create one
 * after onboarding. A transfer is otherwise unreachable at all:
 * TransactionForm gates its Transfer chip on `wallets.length >= 2`. The new
 * wallet inherits the first wallet's own currency (wallet-rows.ts's
 * `defaultCurrencyFor`), so the transfer below stays same-currency and
 * never needs the cross-currency "They receive" amount field.
 */
async function addWallet(page: Page, name: string) {
  await page.goto("/wallets");
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByText(name)).toBeVisible();
}

/** The keypad is a grid of `<button>`s (AmountKeypad.tsx) — one press per
 *  character, identical to ledger.spec.ts's own helper. */
async function pressAmount(page: Page, amount: string) {
  for (const key of amount) {
    await page.getByRole("button", { name: key, exact: true }).click();
  }
}

/**
 * Records one expense or income transaction via /transactions/new and
 * waits for the redirect to /transactions that confirms the save landed.
 * `category` must be a category of the matching kind — CategoryPicker
 * filters its list by `kind`, so an income transaction can only ever be
 * filed against an income category (e.g. "Salary"), never an expense one
 * like "Groceries". That restriction is exactly why this suite's "watch it
 * fail" exercise (below) has to target the wallet's OVERALL cap rather
 * than a single category: income can never be filed under Groceries
 * through this screen, so a category-scoped budget could never show a
 * leak no matter what the SQL does — only a cap that sums the whole
 * wallet can.
 */
async function recordTransaction(page: Page, kind: "expense" | "income", amount: string, category: string) {
  await page.goto("/transactions/new");
  if (kind === "income") {
    // Same technique as ledger.spec.ts's Transfer chip: click the visible
    // label, not `.check()` on the underlying `sr-only` radio, since the
    // label is the real hit target a user clicks.
    await page.getByText("Income", { exact: true }).click();
  }
  await pressAmount(page, amount);
  await page.getByRole("button", { name: category }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL("/transactions");
}

/** Records a transfer from the onboarding wallet to the second wallet
 *  `addWallet` created — TransactionForm's own defaults already point the
 *  "To" select at whichever wallet isn't currently selected as "From". */
async function recordTransfer(page: Page, amount: string) {
  await page.goto("/transactions/new");
  await page.getByText("Transfer", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Transfer" })).toBeChecked();
  await pressAmount(page, amount);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL("/transactions");
}

/**
 * The `<li>` for one budget row. Every pinned control on /budgets
 * (`Budget amount`, `Save budget`, the alert/status live regions) renders
 * ONCE PER ROW (task-6-brief.md's controller addendum 2, verified against
 * BudgetList.tsx), so a bare `page.getByLabel("Budget amount")` throws a
 * strict-mode violation the moment more than one row is on screen — which
 * is true for nearly every assertion below, since this test deliberately
 * keeps both a category budget (Groceries) and the wallet's overall cap
 * (All spending) live at once.
 */
function budgetRow(page: Page, label: string) {
  return page.getByRole("listitem").filter({ hasText: label });
}

/** Fills a row's amount field and saves it, waiting for the row's own
 *  per-row status region to confirm the write landed. */
async function setBudgetOnRow(row: ReturnType<typeof budgetRow>, amount: string) {
  await row.getByLabel("Budget amount").fill(amount);
  await row.getByRole("button", { name: "Save budget" }).click();
  await expect(row.getByText("Budget saved.", { exact: true })).toBeVisible();
}

test("a budget counts expenses, and ignores income and transfers", async ({ page }) => {
  await signUpAndOnboard(page, "Everyday");
  await addWallet(page, "Savings"); // unlocks the Transfer chip

  // get_budget_status (0012) only returns a row for a category (or the
  // overall cap) that already has spending OR an existing budget — its
  // `spend`/`eff` CTEs never enumerate an untouched category. So a budget
  // cannot be set on Groceries, or on the wallet's overall cap, before
  // /budgets has at least one row to show for that wallet at all. Record
  // the first expense before ever visiting /budgets, rather than the
  // "set the budget first" order the plan sketched — the real screen
  // renders nothing to set a budget ON until this exists.
  await recordTransaction(page, "expense", "30", "Groceries");

  await page.goto("/budgets");
  const groceries = budgetRow(page, "Groceries");
  const overall = budgetRow(page, "All spending");
  await expect(groceries.getByText("$30.00 spent · No budget set")).toBeVisible();
  await expect(overall.getByText("$30.00 spent · No budget set")).toBeVisible();

  // Budget BOTH the category and the wallet's overall cap at 100, so both
  // shapes spec §1 calls out ("per category and overall cap ... both
  // rendered") are exercised by the same scenario.
  await setBudgetOnRow(groceries, "100");
  await setBudgetOnRow(overall, "100");
  await expect(groceries.getByText("$30.00 of $100.00 · 30%")).toBeVisible();
  await expect(overall.getByText("$30.00 of $100.00 · 30%")).toBeVisible();

  // *** The assertion this whole feature is defined by ***
  // Income against a real income category ("Salary", one of the seeded
  // defaults) must move NEITHER figure. Both rows must still read exactly
  // 30 of 100 — not 530, not anything else.
  await recordTransaction(page, "income", "500", "Salary");
  await page.goto("/budgets");
  await expect(budgetRow(page, "Groceries").getByText("$30.00 of $100.00 · 30%")).toBeVisible();
  await expect(budgetRow(page, "All spending").getByText("$30.00 of $100.00 · 30%")).toBeVisible();

  // A transfer between the two wallets must not move either figure either
  // — money moving between accounts is not spending in either one.
  await recordTransfer(page, "40");
  await page.goto("/budgets");
  await expect(budgetRow(page, "Groceries").getByText("$30.00 of $100.00 · 30%")).toBeVisible();
  await expect(budgetRow(page, "All spending").getByText("$30.00 of $100.00 · 30%")).toBeVisible();

  // A further genuine expense DOES move both figures, past the cap, and
  // the overrun is stated in words, never by colour alone.
  await recordTransaction(page, "expense", "80", "Groceries");
  await page.goto("/budgets");
  const groceriesOver = budgetRow(page, "Groceries");
  const overallOver = budgetRow(page, "All spending");
  await expect(groceriesOver.getByText("$110.00 of $100.00 · 110%")).toBeVisible();
  await expect(groceriesOver.getByText("Over by $10.00")).toBeVisible();
  await expect(overallOver.getByText("$110.00 of $100.00 · 110%")).toBeVisible();
  await expect(overallOver.getByText("Over by $10.00")).toBeVisible();
});
