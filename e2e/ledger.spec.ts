import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Task 23's end-to-end suite. Runs against the LOCAL Supabase stack
 * (`npx supabase start`) — `supabase/config.toml` sets
 * `[auth.email] enable_confirmations = false`, so a signup here is
 * immediately signed in and no mailbox step is needed.
 *
 * SCOPE NOTE — no transfer test. The plan's sketch for this task walked
 * "signup through TRANSFER and undo", but a transfer needs two wallets and
 * there is no UI that creates a second one: `createWallet` is imported by
 * exactly one file (src/app/onboarding/onboarding-form.tsx), and
 * /onboarding redirects to / the moment an active wallet exists. The
 * plan's own "known gaps" section lists the /wallets management screen as
 * deferred, so this is the deferral surfacing, not a regression. Transfer
 * behaviour IS covered below the UI — src/server/actions/transactions.test.ts
 * for the action and scripts/test-rls.sh for `create_transfer`'s
 * membership/pair invariants — so what's missing is browser coverage
 * specifically, and it stays missing until a wallet-creation screen exists.
 */

/** `formatMoney` renders U+2212 MINUS SIGN, not an ASCII hyphen (src/lib/money.ts). */
const MINUS = "−";
const PASSWORD = "test-password-123";

/**
 * Unique per call, not per file: both the `desktop` and `mobile` projects
 * run every test against the same Postgres, and `Date.now()` alone
 * collides when two projects reach the same line in the same millisecond.
 */
let userCount = 0;
const uniqueEmail = () => `e2e-${Date.now()}-${userCount++}@example.com`;

/**
 * Signs up a fresh user and completes onboarding, leaving the page on the
 * dashboard with exactly one wallet and Task 11's seeded default
 * categories. Every test starts from here — there is no shared/seeded E2E
 * account, so no test can be broken by another test's leftovers.
 */
async function signUpAndOnboard(page: Page, walletName = "Everyday"): Promise<string> {
  const user = uniqueEmail();

  await page.goto("/signup");
  await page.getByLabel("Email").fill(user);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  // signUp redirects to /onboarding (src/server/actions/auth.ts).
  await expect(page.getByRole("heading", { name: "Add your first account" })).toBeVisible();
  await page.getByLabel("Name").fill(walletName);
  await page.getByRole("button", { name: "Create account" }).click();

  // createWallet redirects to /, which (app)/layout.tsx now lets through
  // because the wallet count is no longer zero.
  await expect(page).toHaveURL("/");
  return user;
}

/**
 * The keypad is a grid of `<button>`s, not a text input — deliberately, so
 * the OS keyboard never opens (src/components/AmountKeypad.tsx). Typing an
 * amount therefore means pressing keys, one per character.
 */
async function pressAmount(page: Page, amount: string) {
  for (const key of amount) {
    await page.getByRole("button", { name: key, exact: true }).click();
  }
}

/**
 * The `<output>` showing the running total. Scoped through the wrapping
 * `role="group"` rather than reached with `getByLabel("Amount")`, which is
 * ambiguous: the output carries `aria-label="Amount"` AND the group is
 * labelled by a `<p>` that also reads "Amount"
 * (src/components/TransactionForm.tsx) — two matches, and Playwright's
 * strict mode rejects that.
 */
const amountDisplay = (page: Page) =>
  page.getByRole("group", { name: "Amount" }).locator("output");

test.describe("ledger", () => {
  test("signup, onboard, add an expense, delete it, undo", async ({ page }) => {
    await signUpAndOnboard(page);

    await page.goto("/transactions/new");
    await pressAmount(page, "12.50");
    await expect(amountDisplay(page)).toHaveText("$12.50");

    // "Groceries" is one of Task 11's default categories, inserted by the
    // new-user trigger in supabase/migrations/0007_seed_user.sql.
    await page.getByRole("button", { name: "Groceries" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // TransactionForm pushes to /transactions on success.
    await expect(page).toHaveURL("/transactions");

    // The sign is rendered as text, never carried by colour alone (spec §6.4).
    const amountText = `${MINUS}$12.50`;
    await expect(page.getByText(amountText)).toBeVisible();

    // The row's Delete button names the amount too, so several same-category
    // rows don't collide on one accessible name.
    await page.getByRole("button", { name: `Delete Groceries, ${amountText}` }).click();

    // `exact` matters: the visually-hidden role="status" twin says
    // "Groceries deleted. Undo available." and would otherwise also match.
    await expect(page.getByText("Groceries deleted", { exact: true })).toBeVisible();
    await expect(page.getByText(amountText)).toHaveCount(0);

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByText(amountText)).toBeVisible();
  });

  test("an expense reaches the dashboard's total, breakdown and cash flow", async ({ page }) => {
    await signUpAndOnboard(page);

    await page.goto("/transactions/new");
    await pressAmount(page, "40");
    await page.getByRole("button", { name: "Groceries" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page).toHaveURL("/transactions");

    await page.goto("/");
    // Hero total (Task 21) — spent this month, unsigned.
    await expect(page.getByText("$40.00").first()).toBeVisible();
    // Both charts render their data as a real <table> twin, not only as
    // colour (Tasks 21/22), so this asserts on the accessible content.
    await expect(page.getByRole("table", { name: /Spending by category/ })).toBeVisible();
    await expect(page.getByRole("img", { name: /Cash flow by period/ })).toBeVisible();
  });
});

/**
 * Accessibility gates. Signed-out pages are scanned directly; the signed-in
 * pages need a user first, which is why they share one test rather than
 * running the (slow) signup once per route.
 */
async function expectNoViolations(page: Page, context: string) {
  // `best-practice` is included deliberately, beyond the plan's own
  // `wcag2a`/`wcag2aa`. It is what caught the only real finding this task
  // turned up: neither / nor /transactions/new had a level-one heading, so
  // both documents' outlines started at `<h2>` (`page-has-heading-one` is
  // a best-practice rule, not a Success Criterion — the A/AA-only gate
  // passed the whole time the gap existed). Both are fixed; keeping the
  // tag in the gate is what stops the next page from reintroducing it.
  // Verified clean across every route below in BOTH projects, so this is a
  // floor the app already meets, not an aspiration.
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "best-practice"]).analyze();
  expect(
    results.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.help}`),
    `axe violations on ${context}`,
  ).toEqual([]);
}

test.describe("accessibility", () => {
  for (const path of ["/login", "/signup"]) {
    test(`${path} has no accessibility violations`, async ({ page }) => {
      await page.goto(path);
      await expectNoViolations(page, path);
    });
  }

  test("signed-in pages have no accessibility violations", async ({ page }) => {
    await signUpAndOnboard(page);

    for (const path of ["/", "/transactions", "/transactions/new", "/categories"]) {
      await page.goto(path);
      await expectNoViolations(page, path);
    }
  });
});
