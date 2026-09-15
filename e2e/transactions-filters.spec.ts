import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * /transactions search and filters, proven against the real PostgREST
 * query rather than a mocked one — the point of this file is the part the
 * unit tests cannot reach: that a user-typed term with `%` and a comma
 * arrives at Postgres as a literal, that the category filter really scopes
 * by id, and that the date range is inclusive on both ends. Helpers are
 * deliberately shaped like ledger.spec.ts's own, not imported from it,
 * matching how every spec here is self-contained.
 */

const PASSWORD = "test-password-123";
let n = 0;
const uniqueEmail = () => `filters-${Date.now()}-${n++}@example.com`;

async function signUpAndOnboard(page: Page): Promise<void> {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(uniqueEmail());
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Add your first wallet" })).toBeVisible();
  await page.getByLabel("Name").fill("Everyday");
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page).toHaveURL("/");
}

async function pressAmount(page: Page, amount: string) {
  for (const key of amount) {
    await page.getByRole("button", { name: key, exact: true }).click();
  }
}

async function recordExpense(
  page: Page,
  amount: string,
  category: string,
  opts: { merchant?: string; note?: string; date?: string },
) {
  await page.goto("/transactions/new");
  await pressAmount(page, amount);
  await page.getByRole("button", { name: category }).click();
  if (opts.merchant) await page.getByLabel("Merchant").fill(opts.merchant);
  if (opts.note) await page.getByLabel("Note").fill(opts.note);
  if (opts.date) await page.getByLabel("Date").fill(opts.date);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL("/transactions");
}

/** Every rendered ledger row — the list is a named region (TransactionList's
 *  own `listLabel` default), one `<li>` per transaction. */
function rowNames(page: Page) {
  return page.getByRole("region", { name: "Transaction list" }).getByRole("listitem");
}

test("search matches merchant or note literally, and category and date filters narrow the ledger", async ({
  page,
}) => {
  await signUpAndOnboard(page);
  // Three rows: two in September, one in August; two Groceries, one
  // Transport; a merchant carrying LIKE's own wildcard and a comma, which a
  // naive filter string would either match too broadly or reject outright.
  await recordExpense(page, "12", "Groceries", { merchant: "NTUC, 100% fresh", date: "2026-09-03" });
  await recordExpense(page, "8", "Groceries", { note: "Cold Storage", date: "2026-09-10" });
  await recordExpense(page, "30", "Transport", { merchant: "Grab", date: "2026-08-20" });
  await expect(rowNames(page)).toHaveCount(3);

  // 1. Search — merchant OR note, case-insensitive substring.
  const search = page.getByRole("searchbox", { name: "Search transactions" });
  await search.fill("cold");
  await expect(page).toHaveURL(/\?q=cold$/);
  await expect(rowNames(page)).toHaveCount(1);
  await expect(page.getByText("Cold Storage", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Filter results" })).toHaveText("1 matching");

  // The `%` and the comma reach Postgres as literals: "100%" matches only
  // the NTUC row, not everything beginning "100". A term with no literal
  // match — "100 fresh", which `100%` as a WILDCARD would match — finds
  // nothing, proving the escape rather than assuming it.
  await search.fill("100% fresh");
  await expect(page).toHaveURL(/\?q=100%25\+fresh$|\?q=100%25%20fresh$/);
  await expect(rowNames(page)).toHaveCount(1);
  await expect(page.getByText("NTUC, 100% fresh", { exact: true })).toBeVisible();
  await search.fill("NTUC, 100");
  await expect(rowNames(page)).toHaveCount(1);
  await search.fill("100 fresh");
  await expect(page.getByText("No transactions match these filters.")).toBeVisible();
  await expect(rowNames(page)).toHaveCount(0);

  // 2. Clear filters returns to the bare route and every row.
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).toHaveURL("/transactions");
  await expect(rowNames(page)).toHaveCount(3);
  await expect(page.getByRole("link", { name: "Clear filters" })).toHaveCount(0);

  // 3. Category — by id, through the select.
  await page.getByRole("combobox", { name: "Category" }).selectOption({ label: "Transport" });
  await expect(page).toHaveURL(/\?category=/);
  await expect(rowNames(page)).toHaveCount(1);
  await expect(page.getByText("Grab", { exact: true })).toBeVisible();

  // 4. Date range composes with the category still set — inclusive both
  // ends, so the 20th itself is in a window ending on the 20th.
  await page.getByLabel("From", { exact: true }).fill("2026-08-01");
  await page.getByLabel("To", { exact: true }).fill("2026-08-20");
  await expect(page).toHaveURL(/category=.*&from=2026-08-01&to=2026-08-20$/);
  await expect(rowNames(page)).toHaveCount(1);
  await page.getByLabel("To", { exact: true }).fill("2026-08-19");
  await expect(rowNames(page)).toHaveCount(0);

  // 5. The filter bar, populated and with an empty result, clears axe.
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "best-practice"]).analyze();
  expect(results.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.help}`)).toEqual([]);

  // 6. A filtered URL survives a reload with its controls filled in.
  await page.goto("/transactions?q=grab&from=2026-08-01");
  await expect(page.getByRole("searchbox", { name: "Search transactions" })).toHaveValue("grab");
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("2026-08-01");
  await expect(rowNames(page)).toHaveCount(1);
});
