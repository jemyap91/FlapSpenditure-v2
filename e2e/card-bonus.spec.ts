import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * The card bonus flow end to end, against the LOCAL Supabase stack: set a
 * wallet's terms, spend on it, and watch Home, the entry form and Activity
 * agree. Helpers are duplicated from ledger.spec.ts, as recurring.spec.ts
 * does, rather than exported from a spec file.
 */

const PASSWORD = "test-password-123";

let userCount = 0;
const uniqueEmail = () => `e2e-bonus-${Date.now()}-${userCount++}@example.com`;

async function signUpAndOnboard(page: Page, walletName: string) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(uniqueEmail());
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Add your first wallet" })).toBeVisible();
  await page.getByLabel("Name").fill(walletName);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page).toHaveURL("/");
}

/** Phone and desktop reach a wallet's edit dialog differently (see ledger.spec.ts). */
async function openWalletSettings(page: Page, walletName: string) {
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page.getByRole("button", { name: `More actions for ${walletName}` }).click();
    await page.getByRole("button", { name: `Settings for ${walletName}` }).click();
  } else {
    await page.getByRole("button", { name: `Edit ${walletName}` }).click();
  }
}

async function pressAmount(page: Page, amount: string) {
  for (const key of amount) {
    await page.getByRole("button", { name: key, exact: true }).click();
  }
}

async function expectNoViolations(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "best-practice"]).analyze();
  expect(
    results.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.help}`),
    `axe violations on ${context}`,
  ).toEqual([]);
}

/** Fills the entry form's amount, merchant and category, optionally picking a channel. */
async function fillExpense(page: Page, amount: string, merchant: string, channel?: string) {
  await pressAmount(page, amount);
  await page.getByRole("button", { name: "Groceries" }).click();
  await page.getByLabel("Merchant").fill(merchant);
  if (channel) await page.getByRole("radio", { name: channel, exact: true }).check({ force: true });
}

const save = (page: Page) => page.getByRole("button", { name: "Save", exact: true }).click();

test.describe("card bonus", () => {
  test("terms, spend, mismatch warning, filter, remembered channel and max warning", async ({ page }) => {
    await signUpAndOnboard(page, "Everyday");

    // 1. Card terms live in the wallet's edit dialog.
    await page.goto("/wallets");
    await openWalletSettings(page, "Everyday");
    const dialog = page.getByRole("dialog", { name: "Edit Everyday" });
    await dialog.getByLabel("Bonus channel for Everyday").selectOption({ label: "Online" });
    await dialog.getByLabel("Cycle start day for Everyday").fill("1");
    await dialog.getByLabel("Max for Everyday").fill("100");
    await dialog.getByRole("button", { name: "Save card terms for Everyday" }).click();
    // The edit dialog stays open (it may hold unsaved edits) and says so.
    await expect(dialog.getByText("Saved")).toBeVisible();

    // 2. A $30 Online expense at Uniqlo (Online is preselected by the card).
    await page.goto("/transactions/new");
    await expect(page.getByRole("radio", { name: "Online", exact: true })).toBeChecked();
    await fillExpense(page, "30", "Uniqlo");
    await save(page);
    await expect(page).toHaveURL("/transactions");
    await page.goto("/");
    await expect(page.getByText("$30.00 / $100.00")).toBeVisible();

    // 3. A second Uniqlo expense in store: the warning shows before saving.
    await page.goto("/transactions/new");
    await fillExpense(page, "5", "Uniqlo", "In store");
    await expect(
      page.getByRole("status", { name: "Warnings for Everyday" }).getByText(/won't earn it/),
    ).toBeVisible();

    // 4. Warnings never block Save. Activity says "No bonus"; Home does not count it.
    await save(page);
    await expect(page).toHaveURL("/transactions");
    await expect(page.getByText("No bonus")).toHaveCount(1);
    await page.goto("/");
    await expect(page.getByText("$30.00 / $100.00")).toBeVisible();
    const noBonus = page.getByRole("link", { name: "1 no bonus, Everyday" });
    await expect(noBonus).toBeVisible();
    await expectNoViolations(page, "/ (card bonus section)");

    // 5. The link opens the real filter: only the in-store expense.
    await noBonus.click();
    await expect(page).toHaveURL(/\/transactions\?.*mismatch=1/);
    await expect(page.getByRole("button", { name: /^Delete / })).toHaveCount(1);
    await expect(page.getByText("−$5.00")).toBeVisible();
    await expect(page.getByText("−$30.00")).toHaveCount(0);

    // 6. The correction is remembered per merchant, whatever the case.
    await page.goto("/transactions/new");
    await page.getByLabel("Merchant").fill("uniqlo");
    await expect(page.getByRole("radio", { name: "In store", exact: true })).toBeChecked();

    // 7. $90 Online pushes the cycle past its max.
    await page.goto("/transactions/new");
    await fillExpense(page, "90", "Cold Storage");
    await expect(page.getByRole("radio", { name: "Online", exact: true })).toBeChecked();
    await expect(
      page.getByRole("status", { name: "Warnings for Everyday" }).getByText(/past its .*100\.00 max/),
    ).toBeVisible();
    await save(page);
    await expect(page).toHaveURL("/transactions");
    await page.goto("/");
    await expect(page.getByText("$120.00 / $100.00")).toBeVisible();
  });
});
