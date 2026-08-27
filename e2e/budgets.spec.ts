import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Task 8's end-to-end proof of the feature's defining requirement, in the
 * requester's own words: "budgets should only register for expenses.
 * income and transfers shouldn't be included." Everything else in this
 * file is supporting cast for that one sentence.
 *
 * `supabase/tests/rls.sql` (search "Expenses-only: budgets register
 * spending for kind = 'expense' ONLY", ~line 2325) already proves the
 * filter at query level. What that suite cannot cover is the browser:
 * whether the SCREEN a person actually reads renders the right figures,
 * with the right rows, off the right controls. That is what this file
 * proves instead.
 *
 * Runs against the LOCAL Supabase stack, same as e2e/ledger.spec.ts — see
 * that file's own doc comment for the confirmations-disabled signup flow
 * this relies on. Helpers below are deliberately shaped like that file's
 * (`signUpAndOnboard`, `pressAmount`, `addWallet`) rather than imported
 * from it, matching how that file is itself a single self-contained spec
 * with no shared helper module.
 *
 * REWRITTEN against the wallet-set model (0013_wallet_set_budgets.sql):
 * the OLD single-wallet screen rendered one `<li>` per WALLET; this one
 * renders one `<section>` per BUDGET (a budget now covers a SET of
 * wallets), plus a shared `<ul>` of `<li>` for spending no visible budget
 * covers. See BudgetList.tsx's own doc comments for the full shape.
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
 * `defaultCurrencyFor`), so both wallets stay same-currency, are both
 * offered by the budget screen's wallet picker (which only ever lists
 * primary-currency wallets), and a transfer between them never needs the
 * cross-currency "They receive" amount field.
 *
 * Added immediately after onboarding, before this file's own budget
 * assertions begin — not later, where the plan's own step ordering might
 * suggest — because a transfer (needed to prove the second half of the
 * requirement: "transfers shouldn't be included") is structurally
 * unreachable at one wallet. Having it in place from the start also lets
 * the wallet-set assertions (a budget scoped to ONE of the two wallets)
 * reuse the same wallet without a second `addWallet` call mid-file.
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
 * renders categories as `<button>`s filtered by `kind`, so an income
 * transaction can only ever be filed against an income category (e.g.
 * "Salary"), never an expense one like "Groceries".
 *
 * That restriction is one of FOUR independent layers standing between an
 * income/transfer transaction and an expense category's own row: the
 * picker filters by kind, the picker is not rendered at all for a transfer
 * (see recordTransfer below), createTransaction/createTransfer reject a
 * kind mismatch server-side, and 0003's `transfer_shape` CHECK forces a
 * transfer's `category_id` to NULL in the database regardless. A
 * CATEGORY-scoped budget (Groceries, below) therefore cannot be made to
 * show a leak through this screen no matter what `get_budget_status`'s SQL
 * does — only a NEW row appearing (income landing in an unbudgeted
 * category) can. See the row-count assertions below for the actual proof.
 *
 * `walletName`, when given, selects the transaction's "Account" — the
 * form defaults to the first wallet (`wallets[0]`, the onboarding wallet),
 * so this is only needed to file against the SECOND wallet.
 */
async function recordTransaction(
  page: Page,
  kind: "expense" | "income",
  amount: string,
  category: string,
  walletName?: string,
) {
  await page.goto("/transactions/new");
  if (kind === "income") {
    // Same technique as ledger.spec.ts's Transfer chip: click the visible
    // label, not `.check()` on the underlying `sr-only` radio, since the
    // label is the real hit target a user clicks.
    await page.getByText("Income", { exact: true }).click();
  }
  if (walletName) {
    // "Account" is sr-only for a non-transfer kind (TransactionForm.tsx)
    // but still the select's accessible name, so getByLabel still finds it.
    await page.getByLabel("Account").selectOption({ label: walletName });
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
 * One BUDGET row, scoped by its own pinned heading format
 * (`<category label> · <scope label>`, controller addendum's verified
 * markup contract). A budget row is a `<section aria-labelledby>`, which —
 * because it carries an accessible name from its own `<h2>` — is exposed
 * as `role="region"`, so this can select it directly rather than filtering
 * a broader locator by text.
 *
 * Scoping matters here specifically because a category can carry TWO
 * budgets at once (different wallet sets, e.g. "Groceries · All accounts"
 * and "Groceries · Savings") whose Remove buttons share the exact same
 * `aria-label` (`Remove budget for Groceries` — derived from the category
 * label alone, not the scope). A bare `page.getByRole("button", { name:
 * "Remove budget for Groceries" })` would violate strict mode the moment
 * both exist; going through this row locator first resolves it, since
 * only one such button exists within any single row's own subtree.
 */
function budgetRow(page: Page, heading: string) {
  return page.getByRole("region", { name: heading });
}

/** The "Add a budget" form — also a `<section aria-labelledby>`, so also a
 *  named region. The ONLY place a Category picker or a wallet PICKER (as
 *  opposed to an existing row's own hidden, unpicked wallet set) exists on
 *  this screen, and the only place `Budget amount`/`Save budget` refer to
 *  a NEW budget rather than an existing row — scoping here is what makes
 *  `page.getByLabel("Budget amount")` resolve to one control instead of
 *  colliding with every row already on screen. */
function addBudgetForm(page: Page) {
  return page.getByRole("region", { name: "Add a budget" });
}

/**
 * Creates a new budget through the Add-a-budget form: picks the category
 * (or the overall cap, via its exact invented label — controller addendum:
 * "Overall budget (all spending)", pinned nowhere else so it is hardcoded
 * here), optionally narrows the wallet picker below its all-checked
 * default, fills the amount, and confirms the save through the form's own
 * `Status for new budget` live region.
 */
async function createBudget(
  page: Page,
  category: string,
  amount: string,
  opts: { uncheckWallets?: string[] } = {},
) {
  await page.goto("/budgets");
  const form = addBudgetForm(page);
  await form.getByLabel("Category").selectOption({ label: category });
  const walletGroup = form.getByRole("group", { name: "Accounts this budget covers" });
  for (const name of opts.uncheckWallets ?? []) {
    await walletGroup.getByLabel(name).uncheck();
  }
  await form.getByLabel("Budget amount").fill(amount);
  await form.getByRole("button", { name: "Save budget" }).click();
  await expect(form.getByRole("status", { name: "Status for new budget" })).toHaveText("Budget saved.");
}

/**
 * The total number of "money rows" rendered on /budgets: one per BUDGET
 * (each an `<h2>`-headed `<section>`, per-budget heading format above)
 * plus one per UNCOVERED category (each an `<li>` — controller addendum:
 * "only uncovered-spending rows are list items", the exact contract that
 * makes the old spec's own `getByRole("listitem")` stale for a budget row
 * but still correct for an uncovered one).
 *
 * This is the load-bearing metric for the requirement this file exists to
 * prove: a per-category FIGURE cannot move when income or a transfer leaks
 * through (see recordTransaction's own doc comment on the four layers), so
 * a regression that deleted the expenses-only filter would be invisible to
 * a per-row assertion alone. It is not invisible here — an income
 * transaction filed against an unbudgeted category (Salary, never
 * budgeted below) has nowhere to go but a BRAND NEW uncovered row, which
 * this count catches by moving from N to N+1 when it should stay at N.
 *
 * The two static headings ("Uncovered spending", the section wrapper; "Add
 * a budget", the create form) are excluded — neither is a money row.
 */
async function rowCount(page: Page): Promise<number> {
  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
  const budgetHeadings = headings.filter((h) => h !== "Uncovered spending" && h !== "Add a budget");
  const uncoveredItems = await page.getByRole("listitem").count();
  return budgetHeadings.length + uncoveredItems;
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

test("a budget counts expenses only, in its own wallet set, and ignores income and transfers", async ({
  page,
}) => {
  await signUpAndOnboard(page, "Everyday");
  await addWallet(page, "Savings"); // unlocks Transfer and the wallet-set assertions below

  // get_budget_status only returns a row for a category (or the overall
  // cap) that already has a BUDGET or REAL spending — its `eff`/`uncovered`
  // CTEs never enumerate an untouched category. The Category picker on the
  // Add-a-budget form is not similarly restricted (page.tsx's own query
  // reads every expense category on the primary-currency wallets, with or
  // without spending), so a budget CAN be created against Groceries before
  // any Groceries expense exists — but recording the expense first, as
  // below, means the very first /budgets visit already has something to
  // look at rather than an empty state.
  await recordTransaction(page, "expense", "30", "Groceries");

  // 1. An all-accounts Groceries budget, created with the wallet picker's
  // all-checked default (both "Everyday" and "Savings"). ALSO an all-
  // accounts overall cap ("Overall budget (all spending)", the picker's
  // own no-category option) — needed for the transfer half of step 2
  // below, not just the category budget: a transfer's `category_id` is
  // always NULL (0003's `transfer_shape` CHECK), so it can NEVER match a
  // category-scoped budget's `e.category_key` (non-null for Groceries) —
  // filter or no filter, that layer alone already excludes it there. The
  // overall cap's own `e.category_key IS NULL` branch is the ONLY row on
  // this screen that sums spending regardless of category, so it is the
  // only row a transfer leak could ever move.
  await createBudget(page, "Groceries", "100");
  await createBudget(page, "Overall budget (all spending)", "1000");
  const groceriesAll = budgetRow(page, "Groceries · All accounts");
  const overallAll = budgetRow(page, "Overall budget · All accounts");
  await expect(groceriesAll.getByText("$30.00 of $100.00 · 30%")).toBeVisible();
  await expect(overallAll.getByText("$30.00 of $1,000.00 · 3%")).toBeVisible();

  // 2. Income against a real income category ("Salary", one of the seeded
  // defaults) and a transfer between the two wallets must move NEITHER the
  // Groceries figure, NOR the overall cap's figure, NOR the row count.
  //
  // The Groceries assertion just below CANNOT, by itself, catch a
  // regression that deletes the expenses-only filter: the four layers
  // documented on recordTransaction's own comment make it structurally
  // impossible for an income or transfer transaction to ever land under a
  // CATEGORY budget through this screen, filter or no filter. It is kept
  // anyway as a regression guard — a join/group-by bug that scrambled the
  // figures without touching the filter would still move it — but it is
  // not this step's proof.
  //
  // The other two ARE real proof, each catching a different one of
  // `get_budget_status`'s two `t.kind = 'expense'` occurrences (0013's
  // `spend` and `uncovered` CTEs):
  //   - the OVERALL CAP figure catches BOTH income and the transfer, since
  //     neither is blocked from it by category matching the way they are
  //     from Groceries — only the kind filter (spend CTE) stands between
  //     either one and this row's sum.
  //   - the ROW COUNT catches income specifically: filed against "Salary"
  //     (never budgeted here), it has nowhere to register but a brand-new
  //     uncovered row if the uncovered CTE's own kind filter is gone. (A
  //     transfer can never do this even with that filter removed — its
  //     NULL category_id fails the CTE's own inner join to `categories`
  //     outright — so the row count is not a transfer proof; the overall
  //     cap figure above is.)
  // Both were watched failing for real — see this task's report for the
  // exact figures.
  const countBeforeLeakAttempt = await rowCount(page);
  await recordTransaction(page, "income", "500", "Salary");
  await recordTransfer(page, "40");
  await page.goto("/budgets");
  await expect(groceriesAll.getByText("$30.00 of $100.00 · 30%")).toBeVisible();
  await expect(overallAll.getByText("$30.00 of $1,000.00 · 3%")).toBeVisible();
  expect(await rowCount(page), "row count must not change: income registers nowhere").toBe(
    countBeforeLeakAttempt,
  );

  // 3. An expense in a DIFFERENT, unbudgeted category must leave Groceries
  // untouched, MOVE the overall cap (which counts every category, budgeted
  // or not — its own defining rule, contrasted against step 2 above), and
  // surface as its own uncovered row — proving the row-count metric above
  // is sensitive at all (it is not simply always equal).
  await recordTransaction(page, "expense", "80", "Transport");
  await page.goto("/budgets");
  await expect(groceriesAll.getByText("$30.00 of $100.00 · 30%")).toBeVisible();
  await expect(overallAll.getByText("$110.00 of $1,000.00 · 11%")).toBeVisible(); // 30 + 80
  const transport = page.getByRole("listitem").filter({ hasText: "Transport" });
  await expect(transport.getByText("$80.00 spent · No budget set")).toBeVisible();
  expect(await rowCount(page), "a real new category's spend DOES add a row").toBe(countBeforeLeakAttempt + 1);

  // 4. A second Groceries budget, over the Savings wallet ONLY — proving
  // the wallet-set behaviour this whole branch exists for: two budgets
  // over different sets, for the SAME category, render as distinct rows
  // and report independently. Savings has no Groceries spending yet, so
  // this starts at 0.
  await createBudget(page, "Groceries", "50", { uncheckWallets: ["Everyday"] });
  const groceriesSavings = budgetRow(page, "Groceries · Savings");
  await expect(groceriesSavings.getByText("$0.00 of $50.00 · 0%")).toBeVisible();
  await expect(groceriesAll.getByText("$30.00 of $100.00 · 30%")).toBeVisible(); // untouched by the new row

  // 5. An expense in a wallet OUTSIDE the subset budget's set (Everyday,
  // not in the Savings-only set) must move the all-accounts row — which
  // covers every wallet — but not the Savings-only one, which does not
  // cover Everyday at all.
  await recordTransaction(page, "expense", "15", "Groceries"); // defaults to Everyday
  await page.goto("/budgets");
  await expect(groceriesAll.getByText("$45.00 of $100.00 · 45%")).toBeVisible(); // 30 + 15
  await expect(groceriesSavings.getByText("$0.00 of $50.00 · 0%")).toBeVisible(); // unmoved
  await expect(overallAll.getByText("$125.00 of $1,000.00 · 13%")).toBeVisible(); // 110 + 15

  // 6. Remove — the only destructive control on this screen. Targeted by
  // its pinned aria-label, scoped to the all-accounts row specifically
  // (see budgetRow's own doc comment: both Groceries rows share the exact
  // same aria-label, "Remove budget for Groceries", since it is derived
  // from the category label alone, not the scope — an unscoped locator
  // would violate strict mode here).
  //
  // Removing the ALL-ACCOUNTS budget, while the Savings-only one still
  // exists, is what makes this a genuine "falls back to uncovered" case
  // rather than a no-op: Everyday's $45 of Groceries spend loses its only
  // cover (the Savings-only budget never covered Everyday), so it must
  // reappear as bare uncovered spending, while the still-independent
  // Savings-only row — and the overall cap, whose total spend a removed
  // BUDGET can never change — are both untouched.
  await groceriesAll.getByRole("button", { name: "Remove budget for Groceries" }).click();
  await expect(groceriesAll).toHaveCount(0);
  const groceriesUncovered = page.getByRole("listitem").filter({ hasText: "Groceries" });
  await expect(groceriesUncovered.getByText("$45.00 spent · No budget set")).toBeVisible();
  await expect(groceriesSavings.getByText("$0.00 of $50.00 · 0%")).toBeVisible();
  await expect(overallAll.getByText("$125.00 of $1,000.00 · 13%")).toBeVisible();

  // The populated screen — an independent budgeted row, two uncovered
  // rows, and the aftermath of a Remove, all on screen together — must
  // clear the same axe gate every other route in this app holds.
  // ledger.spec.ts's own accessibility sweep visits /budgets too, but only
  // ever with a freshly-onboarded user, which always renders the EMPTY
  // state ("No spending or budgets recorded this month.") — so the
  // progress bar, both per-row live regions, and Remove have never
  // actually been through axe before this assertion.
  await expectNoViolations(page, "/budgets (populated)");
});
