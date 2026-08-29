import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Task 23's end-to-end suite. Runs against the LOCAL Supabase stack
 * (`npx supabase start`) — `supabase/config.toml` sets
 * `[auth.email] enable_confirmations = false`, so a signup here is
 * immediately signed in and no mailbox step is needed.
 *
 * The transfer flow below is reachable only because /wallets can create a
 * SECOND wallet — TransactionForm gates its Transfer chip on
 * `wallets.length >= 2`. Before that screen existed this suite could not
 * exercise a transfer at all.
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
  await expect(page.getByRole("heading", { name: "Add your first wallet" })).toBeVisible();
  await page.getByLabel("Name").fill(walletName);
  await page.getByRole("button", { name: "Create wallet" }).click();

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

  test("the add-transaction screen is reachable from the nav, not only by URL", async ({ page }) => {
    await signUpAndOnboard(page);
    await page.goto("/transactions");

    // Deliberately ONE locator for both projects. Sidebar (`hidden md:flex`)
    // and TabBar (`md:hidden`) are mutually exclusive by breakpoint and only
    // one is in the accessibility tree at a time, so this resolves to
    // whichever nav the viewport actually shows — and fails on the viewport
    // whose nav is missing an entry point. The desktop sidebar had no "Add"
    // item at all, so /transactions/new was unreachable there except by
    // typing the URL, while the mobile tab bar had its "+" the whole time.
    await page.getByRole("link", { name: "Add" }).click();
    await expect(page).toHaveURL("/transactions/new");
  });

  test("a note names the transaction and survives to the list", async ({ page }) => {
    await signUpAndOnboard(page);

    await page.goto("/transactions/new");
    await pressAmount(page, "4.75");
    await page.getByRole("button", { name: "Groceries" }).click();
    await page.getByLabel("Note").fill("Starbucks");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page).toHaveURL("/transactions");

    // The note becomes the row's name; the category is demoted rather than
    // dropped, so both are still on screen.
    await expect(page.getByText("Starbucks", { exact: true })).toBeVisible();
    await expect(page.getByText("Groceries · Everyday", { exact: true })).toBeVisible();

    // The Delete button and the toast both say what the row says, rather
    // than falling back to the category behind the user's own label.
    await page.getByRole("button", { name: `Delete Starbucks, ${MINUS}$4.75` }).click();
    await expect(page.getByText("Starbucks deleted", { exact: true })).toBeVisible();
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

/** Adds a wallet from /wallets, which is the only screen that can create a
 *  second one (onboarding only ever runs at zero wallets). */
async function addWallet(page: Page, name: string) {
  await page.goto("/wallets");
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Add wallet" }).click();
  await expect(page.getByText(name)).toBeVisible();
}

test.describe("wallets", () => {
  test("lists the onboarding wallet with a balance and refuses to archive the last one", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "Everyday");
    await page.goto("/wallets");

    await expect(page.getByText("Everyday")).toBeVisible();
    // A brand-new wallet's starting balance is 0 — a real computed zero,
    // which must render as an amount rather than the "not computed" dash.
    await expect(page.getByText("$0.00")).toBeVisible();

    await expect(page.getByRole("button", { name: "Archive Everyday" })).toBeDisabled();
    await expect(page.getByText(/need at least one wallet/i)).toBeVisible();
  });

  test("refuses to archive the last wallet when a stale tab still offers it", async ({ page }) => {
    await signUpAndOnboard(page, "Everyday");
    await addWallet(page, "Savings");

    // This tab now renders two wallets, so Archive is enabled on both.
    await expect(page.getByRole("button", { name: "Archive Everyday" })).toBeEnabled();

    // A second tab (same session) archives one, leaving the wallet count
    // at 1 — but THIS tab does not know that. `revalidatePath` runs on the
    // server; it does not reach into an already-rendered client.
    const otherTab = await page.context().newPage();
    await otherTab.goto("/wallets");
    await otherTab.getByRole("button", { name: "Archive Savings" }).click();
    await expect(otherTab.getByText("Savings")).toHaveCount(0);
    await otherTab.close();

    // The stale tab still offers Archive on the only remaining wallet.
    // This is the exact case the UI's disabled state cannot cover and the
    // guard inside `archiveWallet` exists for — and it is a real scenario
    // (two tabs, or a page left open), not a synthetic tamper. Note the
    // DOM cannot be tampered into this state instead: React decides
    // whether to dispatch a click from the fiber's own props, so
    // un-disabling the button in the DOM does not deliver the event.
    await page.getByRole("button", { name: "Archive Everyday" }).click();

    // Asserts on the SERVER message's distinctive tail, not on "need at
    // least one wallet" — WalletList renders a static hint containing
    // that phrase whenever it is showing a lone wallet, so a looser
    // pattern could match text that was already on the page.
    await expect(page.getByText(/Add another before archiving this one/i)).toBeVisible();
  });

  test("a second wallet unlocks Archive on both", async ({ page }) => {
    await signUpAndOnboard(page, "Everyday");
    await addWallet(page, "Savings");

    await expect(page.getByRole("button", { name: "Archive Everyday" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Archive Savings" })).toBeEnabled();

    await page.getByRole("button", { name: "Archive Savings" }).click();
    await expect(page.getByText("Savings")).toHaveCount(0);
    // Back down to one wallet, so the guard re-engages.
    await expect(page.getByRole("button", { name: "Archive Everyday" })).toBeDisabled();
  });

  test("editing a wallet's opening balance moves its balance by that amount", async ({ page }) => {
    await signUpAndOnboard(page, "Everyday");

    // One expense first, so the assertion below can only pass if the
    // opening figure is ADDED to transactions rather than replacing the
    // balance outright. With no transactions the two designs would be
    // indistinguishable — which is the whole point of this test.
    await page.goto("/transactions/new");
    await pressAmount(page, "18.00");
    await page.getByRole("button", { name: "Groceries" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page).toHaveURL("/transactions");

    await page.goto("/wallets");
    await expect(page.getByText(`${MINUS}$18.00`)).toBeVisible();

    await page.getByRole("button", { name: "Edit Everyday" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Everyday" });
    await expect(dialog).toBeVisible();

    // Currency is not offered: it is fixed once a wallet exists, because
    // every amount already recorded is stored in it.
    await expect(dialog.getByRole("combobox")).toHaveCount(0);

    const balance = dialog.getByLabel("Starting balance");
    await balance.fill("700.00");
    await dialog.getByRole("button", { name: "Save changes" }).click();

    // The dialog closes itself on success — a modal left open over a save
    // that already happened reads as though nothing did.
    await expect(dialog).toBeHidden();

    // 700.00 opening + (−18.00) spent. NOT 700.00: that would mean the
    // edit had overwritten the balance instead of seeding it, which is the
    // design that was explicitly rejected.
    await expect(page.getByText("$682.00")).toBeVisible();
    await expect(page.getByText("$700.00")).toHaveCount(0);
  });

  test("a second wallet unlocks transfers, and undo restores BOTH legs", async ({ page }) => {
    await signUpAndOnboard(page, "Everyday");
    await addWallet(page, "Savings");

    await page.goto("/transactions/new");
    // The Transfer chip does not exist at one wallet (TransactionForm's
    // `canTransfer`), so its presence is itself the assertion.
    const transferChip = page.getByRole("radio", { name: "Transfer" });
    await expect(transferChip).toBeAttached();
    // Clicked via the visible chip, not `.check()` on the radio: the radio
    // is `peer sr-only` (styling is driven off it by its sibling <div>), so
    // it is deliberately not the hit target — its own <label> intercepts
    // the pointer, which is exactly what a real user clicks.
    await page.getByText("Transfer", { exact: true }).click();
    await expect(transferChip).toBeChecked();
    await pressAmount(page, "25");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page).toHaveURL("/transactions");

    // A transfer is a PAIR of rows with opposite signs (spec §3.2), not one
    // row — the money leaves one wallet and arrives in the other.
    await expect(page.getByText(`${MINUS}$25.00`)).toBeVisible();
    await expect(page.getByText("+$25.00")).toBeVisible();

    // Deleting either leg soft-deletes both (setDeletedAt scopes its UPDATE
    // by transfer_id, not id), and Undo has to restore both.
    await page.getByRole("button", { name: `Delete Transfer, ${MINUS}$25.00` }).click();
    await expect(page.getByText("Transfer deleted", { exact: true })).toBeVisible();
    await expect(page.getByText(`${MINUS}$25.00`)).toHaveCount(0);
    await expect(page.getByText("+$25.00")).toHaveCount(0);

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByText(`${MINUS}$25.00`)).toBeVisible();
    await expect(page.getByText("+$25.00")).toBeVisible();
  });

  test("clicking a wallet opens its detail page, and its add-transaction button returns you there", async ({
    page,
  }) => {
    await signUpAndOnboard(page, "Everyday");
    await addWallet(page, "Savings");

    // A distinguishable expense in EACH wallet, so the isolation assertion
    // below (Everyday's amount shows, Savings' doesn't) can actually tell
    // them apart. $25.00 is avoided on purpose — the transfer test above
    // already uses it, and a wallet's own balance (unsigned `formatMoney`,
    // per WalletList.tsx/[id]/page.tsx) would otherwise print the SAME
    // digits as a wallet's sole expense, so presence checks below key off
    // each row's own "Delete <category>, <amount>" button name rather than
    // the bare amount text.
    await page.goto("/transactions/new");
    await pressAmount(page, "18");
    await page.getByRole("button", { name: "Groceries" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page).toHaveURL("/transactions");

    await page.goto("/transactions/new");
    await page.getByLabel("Wallet").selectOption({ label: "Savings" });
    await pressAmount(page, "33");
    await page.getByRole("button", { name: "Groceries" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page).toHaveURL("/transactions");

    // Click the wallet's NAME on /wallets — the real affordance a user
    // clicks (Task 3 of the wallet-detail plan), not page.goto straight to
    // the detail URL.
    await page.goto("/wallets");
    await page.getByRole("link", { name: "Everyday", exact: true }).click();
    await expect(page).toHaveURL(/\/wallets\/[0-9a-f-]+$/);
    const walletId = new URL(page.url()).pathname.replace("/wallets/", "");

    // Isolation: Everyday's own expense renders here; Savings' does not.
    await expect(page.getByRole("button", { name: `Delete Groceries, ${MINUS}$18.00` })).toBeVisible();
    await expect(page.getByText(`${MINUS}$33.00`)).toHaveCount(0);

    // The FAB's accessible name is pinned by the controller addendum:
    // "Add a transaction to <wallet name>" (WalletFab.tsx). `exact: true` is
    // required and is NOT the default here: Playwright's role-name matcher is
    // case-insensitive SUBSTRING unless told otherwise (see the `name` option
    // in playwright-core's types.d.ts). Testing Library's getByRole is the
    // opposite — exact string equality — and the two are easy to conflate,
    // because the call site and the option name are identical in both.
    await page.getByRole("link", { name: "Add a transaction to Everyday", exact: true }).click();
    await pressAmount(page, "9.99");
    await page.getByRole("button", { name: "Groceries" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // THE load-bearing assertion: saving from this wallet's own FAB returns
    // you to THIS wallet, not the global /transactions list the plain
    // add-transaction flow lands on (see the "ledger" describe block's
    // first test, which asserts that exact URL). A test that only checked
    // the new row appeared would still pass with this redirect completely
    // broken.
    await expect(page).toHaveURL(`/wallets/${walletId}`);
    await expect(page.getByRole("button", { name: `Delete Groceries, ${MINUS}$9.99` })).toBeVisible();

    await expectNoViolations(page, `/wallets/${walletId} (populated)`);
  });

  /**
   * Fix 1 (final whole-branch review): `WalletFab` is `fixed bottom-24
   * right-6 h-14 w-14 … md:bottom-6` (WalletFab.tsx) and, before this fix,
   * nothing reserved that band inside the scrolling content — a wallet
   * with enough transactions to overflow the viewport put its last row's
   * Delete button directly underneath the FAB, unreachable.
   * `toBeVisible()` cannot catch this: an obscured element still passes
   * that matcher. This test scrolls to the bottom of a long list and uses
   * a TRIAL click, which runs Playwright's actionability checks
   * (including "receives pointer events") without dispatching one — it
   * fails exactly when something else is on top.
   *
   * Mobile-only: the occlusion is specific to the mobile FAB position
   * (`bottom-24`, clearing the TabBar) versus the desktop one
   * (`md:bottom-6`, no TabBar — see WalletFab.tsx's own doc comment), and
   * the desktop project's viewport also has far more vertical room, so the
   * same transaction count would not even overflow it there.
   *
   * 14 transactions, not 26: the brief's own reviewer used 20–26 on a
   * Pixel 7 (412×839, this project's exact viewport) for a pixel-precise
   * repro, but this test only needs the list to overflow the viewport AND
   * put its last row's Delete control inside the reserved band once
   * scrolled to the bottom — not reproduce those exact coordinates. 14
   * comfortably overflows 839px (confirmed while writing this test: the
   * assertion below fails without the padding fix and passes with it, at
   * this count) with margin to spare, without paying for 26 UI-driven
   * saves. Every row shares one amount ("1") and category ("Groceries") —
   * this test only needs a long list, not distinguishable rows — and all
   * go to the one "Everyday" wallet from onboarding (no `wallet=`/`from=`
   * query params needed: it is already /transactions/new's default with a
   * single wallet), which is the cheapest path available through this
   * self-contained spec.
   */
  test("the FAB never covers the last row's Delete button on a long list", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile",
      "occlusion is specific to the mobile FAB position (WalletFab.tsx: bottom-24 vs md:bottom-6)",
    );

    await signUpAndOnboard(page, "Everyday");

    for (let i = 0; i < 14; i++) {
      await page.goto("/transactions/new");
      await pressAmount(page, "1");
      await page.getByRole("button", { name: "Groceries" }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page).toHaveURL("/transactions");
    }

    await page.goto("/wallets");
    await page.getByRole("link", { name: "Everyday", exact: true }).click();
    await expect(page).toHaveURL(/\/wallets\/[0-9a-f-]+$/);

    // Every row shares the same accessible name ("Delete Groceries,
    // $1.00") on purpose (see this test's own doc comment) — `.last()`
    // still resolves to the visually last row (bottom of page, DOM order),
    // which is the one this test targets.
    const deleteButtons = page.getByRole("button", { name: /^Delete Groceries, / });
    await expect(deleteButtons).toHaveCount(14);
    const lastDelete = deleteButtons.last();
    await lastDelete.scrollIntoViewIfNeeded();

    // A trial click runs every actionability check (visible, stable,
    // receives pointer events, enabled) WITHOUT dispatching the click —
    // it fails on occlusion the same way a real tap would, which
    // `toBeVisible()` cannot: an obscured element is still "visible" to
    // that matcher.
    await lastDelete.click({ trial: true, timeout: 5000 });
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

test.describe("google sign-in", () => {
  for (const path of ["/login", "/signup"]) {
    test(`${path} offers Continue with Google`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("button", { name: /continue with google/i })).toBeEnabled();
      // The email/password form is an alternative, not a replacement.
      await expect(page.getByLabel("Email")).toBeVisible();
      await expect(page.getByLabel("Password")).toBeVisible();
    });
  }

  // NOT covered here: the Google round trip itself. Completing it needs a
  // real Google account and its consent screen, which a headless run cannot
  // drive and which would make this suite depend on a third party being up.
  // What is covered is everything on this side of the handoff — the button
  // exists, is enabled, and (in GoogleButton.test.tsx) calls
  // signInWithOAuth with the right provider and redirectTo. The leg from
  // Google back into /auth/callback stays a manual check.
});

test.describe("accessibility", () => {
  for (const path of ["/login", "/signup"]) {
    test(`${path} has no accessibility violations`, async ({ page }) => {
      // Same route-health check as the signed-in loop below (fix round 1,
      // item 3): page.goto does not throw on a 500, so a broken
      // signed-out route would otherwise pass this loop silently too.
      const res = await page.goto(path);
      expect(res?.status(), `${path} did not render`).toBeLessThan(400);
      await expectNoViolations(page, path);
    });
  }

  test("signed-in pages have no accessibility violations", async ({ page }) => {
    await signUpAndOnboard(page);

    for (const path of ["/", "/wallets", "/transactions", "/transactions/new", "/budgets", "/categories"]) {
      // `page.goto` does not throw on a 500 — a broken route (e.g. a
      // Server Component crashing on a bad import) renders Next's dev
      // error overlay, which axe can score as violation-free, so the loop
      // below would silently pass on a page that never actually rendered.
      // Caught for real during this fix round: /budgets 500'd from calling
      // a "use client" module's exported function inside a Server
      // Component, and this exact loop (before this assertion existed)
      // still reported zero accessibility violations for it.
      const res = await page.goto(path);
      expect(res?.status(), `${path} did not render`).toBeLessThan(400);
      await expectNoViolations(page, path);
    }
  });
});
