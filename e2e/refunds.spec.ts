import { test, expect, type Page } from "@playwright/test";

/**
 * Refunds end to end (docs/superpowers/specs/2026-09-30-refunds-design.md).
 * Helpers are copied from e2e/ledger.spec.ts rather than imported: each spec
 * file in this repo is self-contained.
 */
const PASSWORD = "test-password-123";
let userCount = 0;
const uniqueEmail = () => `e2e-refunds-${Date.now()}-${userCount++}@example.com`;

async function signUpAndOnboard(page: Page, walletName = "Card") {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(uniqueEmail());
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Add your first wallet" })).toBeVisible();
  await page.getByLabel("Name").fill(walletName);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page).toHaveURL("/");
}

async function pressAmount(page: Page, amount: string) {
  for (const key of amount) await page.getByRole("button", { name: key, exact: true }).click();
}

test("four friends repay their share of a meal", async ({ page }) => {
  await signUpAndOnboard(page, "Card");

  // A second wallet for the money to land in.
  await page.goto("/wallets");
  await page.getByLabel("Name").fill("Bank");
  await page.getByRole("button", { name: "Add wallet" }).click();
  await expect(page.getByText("Bank", { exact: true })).toBeVisible();

  // The expense: 25.00 Eating out, on the card.
  await page.goto("/transactions/new");
  await pressAmount(page, "25");
  await page.getByRole("button", { name: "Eating out" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL("/transactions");

  // Open it and record four repayments into Bank.
  await page.getByRole("link", { name: "Eating out" }).click();
  await expect(page.getByRole("heading", { name: "Repayments" })).toBeVisible();
  for (const who of ["Alice", "Bob", "Chen", "Dee"]) {
    await page.getByLabel("Repayment wallet").selectOption({ label: "Bank" });
    await page.getByLabel("Repayment amount").fill("5");
    await page.getByLabel("Repayment note").fill(who);
    await page.getByRole("button", { name: "Record repayment" }).click();
    await expect(page.getByRole("link", { name: who })).toBeVisible();
  }
  await expect(page.getByText(/Your share\s*\S*5\.00/)).toBeVisible();

  // The ledger shows the repayments as positive rows under the expense's category.
  // This expense has no merchant or note, so the secondary line falls back to the
  // category, which only reaches a refund row through the repaid_expense embed.
  await page.goto("/transactions");
  await expect(page.getByRole("link", { name: "Alice" })).toBeVisible();
  await expect(page.getByText(/Repayment · Eating out/).first()).toBeVisible();

  // The category filter keeps an expense and its repayments together
  // (effective_category_id), and the embedded repaid_expense renders.
  await page.getByRole("combobox", { name: "Category" }).selectOption({ label: "Eating out" });
  await expect(page).toHaveURL(/\?category=/);
  await expect(page.getByRole("link", { name: "Eating out" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Alice" })).toBeVisible();
  await expect(page.getByText(/Repayment · Eating out/).first()).toBeVisible();

  // The dashboard breakdown nets the category to 5.00.
  await page.goto("/");
  const breakdown = page.getByRole("table", { name: /Spending by category/ });
  await expect(breakdown.getByRole("row", { name: /Eating out/ })).toContainText("5.00");

  // The expense can't be deleted while it has repayments.
  await page.goto("/transactions");
  await page.getByRole("button", { name: /^Delete Eating out/ }).click();
  // .last(): a visually-hidden role="status" twin repeats the message for screen readers.
  await expect(page.getByText("This expense has repayments. Delete them first.").last()).toBeVisible();
});
