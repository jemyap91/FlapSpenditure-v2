import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Task 6's end-to-end proof of the feature's defining requirement, in the
 * requester's own words: "budgets should only register for expenses.
 * income and transfers shouldn't be included." Everything else in this
 * file is supporting cast for that one sentence.
 *
 * `supabase/tests/constraints.sql` (search "get_budget_status counts
 * EXPENSES ONLY", ~line 221) already proves the filter at query level — one
 * wallet, one expense, one income, one real `create_transfer` pair,
 * asserting the summed `spent_minor` is the expense alone. What that suite
 * cannot cover is the browser: whether the SCREEN a person actually reads
 * renders the right figures, with the right rows, off the right controls.
 * That is what this file proves instead.
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
 * like "Groceries".
 *
 * That restriction is one of FOUR independent layers standing between an
 * income/transfer transaction and an expense category's own row: the
 * picker filters by kind, the picker is not rendered at all for a transfer
 * (see recordTransfer below), createTransaction/createTransfer reject a
 * kind mismatch server-side, and 0003's `transfer_shape` CHECK forces a
 * transfer's `category_id` to NULL in the database regardless. A
 * CATEGORY-scoped budget (Groceries, below) therefore cannot be made to
 * show a leak through this screen no matter what `get_budget_status`'s SQL
 * does — only the wallet's OVERALL cap, which sums every category's spend
 * for the wallet, actually can. See the comments at the income and
 * transfer steps below for how this test still gets a non-vacuous check
 * out of the category row despite that.
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
 * is true for nearly every assertion below.
 */
function budgetRow(page: Page, label: string) {
  return page.getByRole("listitem").filter({ hasText: label });
}

/**
 * Fills a row's amount field and saves it, confirming the write through
 * the row's OWN pinned live region — `role="status"`,
 * `aria-label="Status for <label>"` (addendum 2's verified contract, which
 * cost a full fix round to land correctly: an earlier draft put the
 * `aria-label` on the wrong node and it silently overrode the describable
 * error text). `label` is `"All spending"` for the overall cap, else the
 * category's own name — the same rule BudgetList.tsx itself uses to build
 * both the alert and the status region's `aria-label`.
 */
async function setBudgetOnRow(row: ReturnType<typeof budgetRow>, label: string, amount: string) {
  await row.getByLabel("Budget amount").fill(amount);
  await row.getByRole("button", { name: "Save budget" }).click();
  await expect(row.getByRole("status", { name: `Status for ${label}` })).toHaveText("Budget saved.");
}

/** Same axe configuration as ledger.spec.ts's own `expectNoViolations` —
 *  duplicated rather than imported, matching how this file is otherwise a
 *  single self-contained spec with no shared helper module (see the file's
 *  own doc comment). */
async function expectNoViolations(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "best-practice"]).analyze();
  expect(
    results.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.help}`),
    `axe violations on ${context}`,
  ).toEqual([]);
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
  await setBudgetOnRow(groceries, "Groceries", "100");
  await setBudgetOnRow(overall, "All spending", "100");
  await expect(groceries.getByText("$30.00 of $100.00 · 30%")).toBeVisible();
  await expect(overall.getByText("$30.00 of $100.00 · 30%")).toBeVisible();

  // Income against a real income category ("Salary", one of the seeded
  // defaults) must move NEITHER figure.
  //
  // The two per-row assertions just below CANNOT, by themselves, catch a
  // regression that deletes the expenses-only filter: the four layers
  // documented on recordTransaction's own comment make it structurally
  // impossible for an income transaction to ever land under Groceries
  // through this screen, filter or no filter. They are kept anyway — a
  // `group by`/join regression that scrambled the figures without
  // touching the filter would still move them — but they are not this
  // step's proof.
  //
  // The row-COUNT check below is what actually is that proof, and it was
  // watched failing for real (task-6-report.md's fix-round section has the
  // exact numbers): with `t.kind = 'expense'` removed from 0012's `spend`
  // CTE, the $500 income materialised its OWN "Salary" row on /budgets —
  // a category that has never had a budget or a real expense has no
  // business appearing here at all — taking the row count from 2 to 3.
  await recordTransaction(page, "income", "500", "Salary");
  await page.goto("/budgets");
  await expect(budgetRow(page, "Groceries").getByText("$30.00 of $100.00 · 30%")).toBeVisible();
  await expect(budgetRow(page, "All spending").getByText("$30.00 of $100.00 · 30%")).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(2); // Groceries + All spending, nothing else

  // A transfer between the two wallets must not move either figure either
  // — money moving between accounts is not spending in either one. Same
  // caveat as the income step: the per-row checks are a regression guard,
  // not proof; the row count is the proof. A leaked transfer leg would
  // give the Savings wallet its own spend for the first time, materialising
  // an entire second wallet SECTION (a "Savings" <h2> plus its own "All
  // spending" row) that must not exist — taking the count from 2 to 3 again.
  await recordTransfer(page, "40");
  await page.goto("/budgets");
  await expect(budgetRow(page, "Groceries").getByText("$30.00 of $100.00 · 30%")).toBeVisible();
  await expect(budgetRow(page, "All spending").getByText("$30.00 of $100.00 · 30%")).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(2);

  // Distinguish the overall cap from the category budget. Every expense up
  // to this point has gone to the ONE budgeted category, so "All spending"
  // and "Groceries" have read identically at every assertion so far and
  // the cap's own defining rule — 0012's own doc comment: the overall cap
  // is "deliberately NOT the sum of the category rows ... it counts every
  // expense in the wallet, including categories with no budget of their
  // own" — has never actually been exercised, at any layer, on this
  // branch. Filing this expense against Transport (unbudgeted, untouched
  // until now) instead of Groceries again is what finally tells the two
  // rows apart: Groceries must stay put, the cap must move by the full
  // amount, and Transport must appear as bare unbudgeted spending.
  await recordTransaction(page, "expense", "80", "Transport");
  await page.goto("/budgets");
  const groceriesFinal = budgetRow(page, "Groceries");
  const overallFinal = budgetRow(page, "All spending");
  const transport = budgetRow(page, "Transport");
  await expect(groceriesFinal.getByText("$30.00 of $100.00 · 30%")).toBeVisible();
  await expect(overallFinal.getByText("$110.00 of $100.00 · 110%")).toBeVisible();
  await expect(overallFinal.getByText("Over by $10.00")).toBeVisible();
  await expect(transport.getByText("$80.00 spent · No budget set")).toBeVisible();

  // Remove — the only destructive control on this screen, and the reason
  // `get_budget_status` was changed to return `budget_id` directly rather
  // than have the UI re-derive it. Targeted by its pinned aria-label, never
  // by its visible text, which discloses the budget's own set-month rather
  // than reading "Remove" (BudgetList.test.tsx already covers that
  // disclosure directly; no need to construct a cross-month fixture here).
  await groceriesFinal.getByRole("button", { name: "Remove budget for Groceries" }).click();
  await expect(groceriesFinal.getByText("$30.00 spent · No budget set")).toBeVisible();

  // The populated screen — a budgeted row, an over-budget cap, a bare
  // unbudgeted row, and the aftermath of a Remove, all on screen together
  // — must clear the same axe gate every other route in this app holds.
  // ledger.spec.ts's own accessibility sweep visits /budgets too, but only
  // ever with a freshly-onboarded user, which always renders the EMPTY
  // state ("No spending or budgets recorded this month.") — so the
  // progress bar, both per-row live regions, and Remove have never
  // actually been through axe before this assertion.
  await expectNoViolations(page, "/budgets (populated)");
});
