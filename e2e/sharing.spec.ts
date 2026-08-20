import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Task 10's end-to-end capstone: the shared-wallet milestone, proven with
 * TWO REAL browser sessions rather than one user talking to itself.
 *
 * Runs against the LOCAL Supabase stack, same as e2e/ledger.spec.ts —
 * `supabase/config.toml` disables email confirmation, so both signups
 * below are immediately signed in.
 *
 * TWO `browser.newContext()` calls, not two pages in one context: each
 * person needs their own cookie jar. Two pages sharing a context share a
 * session, so B's signup would simply replace A's session and every "B"
 * action below would silently be A acting on their own account.
 */

const PASSWORD = "test-password-123";

/**
 * Unique per call, matching e2e/ledger.spec.ts's `uniqueEmail` reasoning:
 * both the `desktop` and `mobile` projects run this file against the same
 * Postgres, and `Date.now()` alone collides when two projects reach the
 * same line in the same millisecond.
 */
let n = 0;
const uniqueEmail = () => `share-${Date.now()}-${n++}@example.com`;

/** The new-user trigger (`handle_new_user`, supabase/migrations/
 *  0007_seed_user.sql) sets `display_name` to `split_part(email, '@', 1)`
 *  — the local part, case preserved. Every email this file generates is
 *  already lowercase, so there is no normalisation gap between what this
 *  helper predicts and what the trigger actually wrote. */
const displayNameOf = (email: string) => email.split("@")[0]!;

/** Signs up a fresh user and completes onboarding, leaving the page on the
 *  dashboard with exactly one wallet. Copied from e2e/ledger.spec.ts's
 *  helper of the same name/shape rather than imported — that file does not
 *  export it, and each spec here is meant to stand alone. */
async function signUpAndOnboard(page: Page, wallet: string): Promise<string> {
  const user = uniqueEmail();

  await page.goto("/signup");
  await page.getByLabel("Email").fill(user);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Add your first account" })).toBeVisible();
  await page.getByLabel("Name").fill(wallet);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL("/");
  return user;
}

/** The keypad is a grid of `<button>`s (src/components/AmountKeypad.tsx),
 *  not a text input, so entering an amount means pressing keys one at a
 *  time — same as e2e/ledger.spec.ts's `pressAmount`. */
async function pressAmount(page: Page, amount: string) {
  for (const key of amount) {
    await page.getByRole("button", { name: key, exact: true }).click();
  }
}

/**
 * Adds a wallet from /wallets — the only screen that can create a SECOND
 * one (onboarding only ever runs at zero wallets). Used here to give A a
 * SOLO wallet that is never shared with B, so the attribution assertions
 * below can distinguish "no co-members yet" from "this row's own wallet
 * genuinely isn't shared."
 */
async function addWallet(page: Page, name: string) {
  await page.goto("/wallets");
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByText(name)).toBeVisible();
}

/**
 * Records an expense. `walletName`, when given, switches the "Account"
 * <select> (TransactionForm.tsx) BEFORE entering the amount/category —
 * switching wallets resets both (`handleWalletChange` clears the category,
 * since a category belongs to the wallet it was created in per 0008, and
 * clamps the amount for the new wallet's currency), so doing it first
 * avoids fighting that reset. Omitted, the form's own default (the
 * earliest-created wallet the caller belongs to) is used, matching
 * e2e/ledger.spec.ts's `addExpense`.
 */
async function addExpense(
  page: Page,
  amount: string,
  category: string,
  note: string,
  walletName?: string,
) {
  await page.goto("/transactions/new");
  if (walletName) {
    await page.getByLabel("Account").selectOption({ label: walletName });
  }
  await pressAmount(page, amount);
  await page.getByRole("button", { name: category, exact: true }).click();
  await page.getByLabel("Note").fill(note);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL("/transactions");
}

/**
 * Each wallet's card on /wallets renders its own `<section
 * aria-labelledby="members-heading-<id>">`, whose `<h2>` carries
 * `aria-label={`${wallet.name} members`}` specifically so a co-owner's
 * SECOND wallet card doesn't collide with the first one's identically
 * labelled "Members" heading (see (app)/wallets/page.tsx's own comment on
 * this). A owns two wallets in this test (Household, and a solo one) —
 * both render an "Invite by email" input and a "Send invitation" button,
 * so every invite/remove interaction below is scoped through this region
 * rather than queried page-wide, or it would be ambiguous.
 */
const membersRegion = (page: Page, walletName: string) =>
  page.getByRole("region", { name: `${walletName} members` });

test("a household shares one ledger between two real people", async ({ browser }) => {
  const ctxA: BrowserContext = await browser.newContext();
  const ctxB: BrowserContext = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  // --- 1. A signs up, onboards into "Household", records an expense with
  // a category AND a note.
  await signUpAndOnboard(a, "Household");
  await addExpense(a, "30", "Groceries", "Market");

  // A's OWN second wallet — never invited, never shared. Exists purely to
  // make the later attribution assertions meaningful: the page-level
  // `showAttribution` flag (attribution.ts) is true the instant ANY wallet
  // on the page is shared, so a test that never gives A a genuinely solo
  // wallet alongside a shared one couldn't tell "attribution is correctly
  // scoped per row" from "attribution happens to be off everywhere."
  await addWallet(a, "A Solo");
  await addExpense(a, "15", "Transport", "Solo diary", "A Solo");

  // --- 2. B signs up and onboards into their OWN, separate wallet — not
  // Household. This matters for step 6: it's what lets this test tell "B's
  // solo wallet" apart from "the shared one" later, and it establishes
  // that onboarding always gives a new user their own wallet regardless of
  // any invitation still to come.
  const bEmail = await signUpAndOnboard(b, "Bs own wallet");
  const bName = displayNameOf(bEmail);

  // --- 3. A invites B by email from /wallets.
  await a.goto("/wallets");
  const householdSection = membersRegion(a, "Household");
  await householdSection.getByLabel("Invite by email").fill(bEmail);
  await householdSection.getByRole("button", { name: "Send invitation" }).click();
  await expect(a.getByText(new RegExp(`Invitation sent to ${bEmail}`, "i"))).toBeVisible();

  // --- 4. B sees the pending invitation on /wallets, naming A's WALLET
  // (not A, not an id), and accepts it.
  await b.goto("/wallets");
  await expect(b.getByText("Household")).toBeVisible();
  await b.getByRole("button", { name: "Accept" }).click();

  // `respondToInvite` runs inside a client-side transition (PendingInvites'
  // own `start(...)`), so the click above only confirms the event
  // dispatched — not that the RPC + revalidation finished. `PendingInvites`
  // renders nothing once there are no invites left (its own early
  // `if (!invites.length) return null`), so waiting for the Accept button
  // to disappear is what confirms the membership actually landed before
  // this test asks /transactions for rows only a member can see.
  await expect(b.getByRole("button", { name: "Accept" })).toHaveCount(0);

  // --- 5. B now sees A's transaction on /transactions with its CATEGORY
  // NAME resolved — the single reason this whole milestone exists.
  // Before the fix, `categories_own` RLS let a co-member read a shared
  // transaction row but not the category row it pointed at, so a
  // partner's rows rendered "Uncategorised" even though
  // get_category_breakdown (SECURITY DEFINER, bypassing RLS) happily named
  // the same category on the dashboard chart. Both directions are
  // asserted: the name IS visible, and "Uncategorised" appears nowhere.
  await b.goto("/transactions");
  await expect(b.getByText("Market", { exact: true })).toBeVisible();
  await expect(b.getByText(/Groceries/)).toBeVisible();
  await expect(b.getByText("Uncategorised")).toHaveCount(0);

  // --- 6. B adds their OWN transaction to the SHARED wallet. A then sees
  // it attributed to B by name — attribution rendering in a real browser
  // for the first time anywhere in this suite (previously covered only by
  // jsdom unit tests in attribution.test.ts).
  await addExpense(b, "12", "Transport", "Bus pass", "Household");
  await a.goto("/transactions");
  await expect(a.getByText("Bus pass", { exact: true })).toBeVisible();
  await expect(a.getByText(new RegExp(`added by ${bName}`, "i"))).toBeVisible();

  // A's OWN SOLO wallet row must show NO attribution segment at all, even
  // on this exact render where the page-level `showAttribution` flag is
  // true because Household (on the same page) IS shared. This is the
  // browser-level regression guard for the page-vs-row gating bug found
  // and fixed in this milestone (attribution.ts's `resolveCreatedByNames`
  // gates PER ROW on that row's own wallet_id being shared, not on the
  // page-wide flag) — get this gate wrong and "added by <you>" leaks onto
  // a private wallet's rows.
  const soloRow = a.locator("li", { hasText: "Solo diary" });
  await expect(soloRow).toBeVisible();
  await expect(soloRow.getByText(/added by/i)).toHaveCount(0);

  // Accessibility sweep while "added by" text is actually rendered. The
  // existing gate in e2e/ledger.spec.ts scans /transactions too, but no
  // test there ever creates a two-member wallet, so this text has never
  // been through axe before. Same tag set that file's own gate uses.
  // Secondary text (the line carrying "added by") uses `--ink-2` (7.53:1
  // against `--page`) rather than `--muted` (3.41:1, fails AA) — this is
  // the check that would catch a regression back to the failing token.
  const results = await new AxeBuilder({ page: a })
    .withTags(["wcag2a", "wcag2aa", "best-practice"])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.help}`),
    "axe violations on /transactions with attribution visible",
  ).toEqual([]);

  // --- 7. A removes B from Household. B's access is revoked immediately —
  // not just A's original transaction, but B's own contribution too, since
  // both live in a wallet B is no longer a member of.
  await a.goto("/wallets");
  await householdSection.getByRole("button", { name: `Remove ${bName}` }).click();
  await expect(householdSection.getByText(bName)).toHaveCount(0);

  await b.goto("/transactions");
  await expect(b.getByText("Market")).toHaveCount(0);
  await expect(b.getByText("Bus pass")).toHaveCount(0);

  await ctxA.close();
  await ctxB.close();
});
