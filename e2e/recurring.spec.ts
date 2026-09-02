import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Task 7's end-to-end proof of the whole recurring-expenses chain, in a
 * real browser against the real local Supabase stack (`npx supabase
 * start`). Tasks 1-6 built and unit-tested every piece of this
 * separately (pure date arithmetic, RLS-scoped schema, server actions,
 * the /recurring screen, the dashboard's DUE section) but nothing before
 * this file has ever exercised all of them together.
 *
 * Self-contained on purpose, like e2e/ledger.spec.ts and e2e/budgets.spec.ts
 * (see the latter's own doc comment for why): `signUpAndOnboard`,
 * `pressAmount` and `expectNoViolations` below are duplicated from
 * e2e/ledger.spec.ts rather than imported.
 *
 * ## Why three separate rules, not one
 *
 * The dashboard's hero total ("spent this month") is scoped to the
 * CURRENT CALENDAR MONTH (`src/lib/month-range.ts`), so an occurrence
 * dated last month can never move it — recording it is still real ledger
 * history, just not *this month's*. That collides with two things this
 * task must prove at once: (1) a recorded occurrence is dated to itself,
 * not to today (the load-bearing assertion, clearest when the occurrence
 * is a full calendar month away from today), and (2) recording turns a
 * due occurrence into real spending the hero total reflects. One
 * occurrence cannot demonstrate both — a date that is "last month" (for
 * (1)) is by construction outside the hero's window (defeating (2)).
 *
 * So this file uses three same-shaped rules, each isolating one
 * assertion:
 *   - "Rent" (anchored last month) proves the dating discrimination.
 *   - "Subscription" (anchored on THIS month's 1st, still before today)
 *     proves the hero total moves once its occurrence is recorded.
 *   - "Gym" (anchored last month, same as Rent) proves Skip leaves the
 *     due list without creating a transaction, and without moving the
 *     hero total either.
 * All three use a YEARLY interval so each contributes exactly ONE due
 * occurrence — a monthly rule anchored a month back would itself already
 * offer two (last month's and this month's), which is correct behaviour
 * (DueList.tsx's own doc comment: "July's rent and August's rent both
 * outstanding") but would make it ambiguous which row a bare "Press
 * Record" targets.
 */

const PASSWORD = "test-password-123";
let userCount = 0;
const uniqueEmail = () => `e2e-recurring-${Date.now()}-${userCount++}@example.com`;

/** Identical shape to ledger.spec.ts's own helper — see that file's doc
 *  comment for why every test starts here rather than off a shared/seeded
 *  account. */
async function signUpAndOnboard(page: Page, walletName = "Everyday"): Promise<string> {
  const user = uniqueEmail();

  await page.goto("/signup");
  await page.getByLabel("Email").fill(user);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Add your first wallet" })).toBeVisible();
  await page.getByLabel("Name").fill(walletName);
  await page.getByRole("button", { name: "Create wallet" }).click();

  await expect(page).toHaveURL("/");
  return user;
}

/** Identical shape to ledger.spec.ts's own helper — the amount keypad is a
 *  grid of buttons, not a text input (src/components/AmountKeypad.tsx). */
async function pressAmount(page: Page, amount: string) {
  for (const key of amount) {
    await page.getByRole("button", { name: key, exact: true }).click();
  }
}

/** Identical configuration to ledger.spec.ts's own `expectNoViolations`. */
async function expectNoViolations(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "best-practice"]).analyze();
  expect(
    results.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.help}`),
    `axe violations on ${context}`,
  ).toEqual([]);
}

/** `formatMoney` renders U+2212 MINUS SIGN, not an ASCII hyphen (src/lib/money.ts). */
const MINUS = "−";

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * Mirrors `DueList.tsx`'s `dueDateLabel` / `RecurringList.tsx`'s
 * `shortDate` exactly: the year is stated only when the occurrence's year
 * differs from today's.
 */
function dueLabel(occurrenceIso: string, todayIso: string): string {
  const [y, m, d] = occurrenceIso.split("-").map(Number) as [number, number, number];
  const withYear = occurrenceIso.slice(0, 4) !== todayIso.slice(0, 4);
  return withYear ? `${d} ${MONTH_ABBR[m - 1]} ${y}` : `${d} ${MONTH_ABBR[m - 1]}`;
}

/**
 * Mirrors `TransactionList.tsx`'s `formatDayHeading` exactly — same
 * `${occurredOn}T00:00:00` construction, so this reads the identical
 * local calendar day the app renders a heading for.
 */
/**
 * The dashboard's hero figure (`(app)/page.tsx`: `<header><h1>…</h1><p
 * className="text-5xl">{formatMoney(spent, currency)}</p>…</header>`) —
 * scoped to `header`'s first `<p>` rather than a bare `getByText`, because
 * `CategoryBreakdown`'s own per-category figures repeat the SAME dollar
 * string (e.g. a lone Groceries expense shows as both the hero total and
 * that category's own breakdown row) and a page-wide text query collides
 * on it the moment more than one category has spending.
 */
function heroTotal(page: Page) {
  return page.locator("header p").first();
}

function dayHeading(occurredOn: string): string {
  const d = new Date(`${occurredOn}T00:00:00`);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

test.describe("recurring", () => {
  test("record dates to the occurrence (not today), skip creates nothing, and the hero total reacts only to what's recorded", async ({
    page,
  }) => {
    const now = new Date();
    // On the 1st of the month, "this month, but before today" does not
    // exist — the scenario below needs that gap (see the file doc comment)
    // to prove dating AND hero-movement with distinguishable dates. This
    // is a real, narrow calendar edge case (1 day in ~30), not a design
    // flaw in the app under test.
    test.skip(
      now.getDate() === 1,
      "this month's anchor would equal today on the 1st, collapsing the discrimination this test relies on",
    );

    const todayIso = isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const thisMonthFirst = isoDate(now.getFullYear(), now.getMonth() + 1, 1);
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthFirst = isoDate(prev.getFullYear(), prev.getMonth() + 1, 1);

    await signUpAndOnboard(page);

    // A known, non-zero baseline for the hero total, so its later movement
    // (or lack of it) is a distinguishable before/after rather than a
    // fragile "went from $0.00 to something".
    await page.goto("/transactions/new");
    await pressAmount(page, "20");
    await page.getByRole("button", { name: "Groceries" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page).toHaveURL("/transactions");

    // Reach /recurring via the link on /transactions, not page.goto — the
    // dashboard's own "Manage" link (DueList.tsx) disappears whenever
    // nothing is due, which is exactly the state this account starts in,
    // so /transactions' link is this route's only permanent entry point.
    await page.getByRole("link", { name: "Recurring", exact: true }).click();
    await expect(page).toHaveURL("/recurring");

    async function addRule(name: string, category: string, anchorOn: string, amount: string) {
      await page.getByLabel("Name").fill(name);
      await page.getByRole("button", { name: category, exact: true }).click();
      await page.getByLabel(/Amount \(/).fill(amount);
      // Yearly: exactly one due occurrence per rule (see file doc comment).
      await page.getByLabel("Repeats").selectOption("yearly");
      await page.getByLabel("Starts on").fill(anchorOn);
      await page.getByRole("button", { name: "Add rule" }).click();
      await expect(page.getByRole("listitem", { name, exact: true })).toBeVisible();
    }

    await addRule("Rent", "Housing", lastMonthFirst, "1000.00");
    await addRule("Subscription", "Subscriptions", thisMonthFirst, "100.00");
    await addRule("Gym", "Health", lastMonthFirst, "50.00");

    await page.goto("/");

    const rentDate = dueLabel(lastMonthFirst, todayIso);
    const subDate = dueLabel(thisMonthFirst, todayIso);
    const gymDate = dueLabel(lastMonthFirst, todayIso);

    const recordRent = page.getByRole("button", { name: `Record Rent for ${rentDate}`, exact: true });
    const recordSub = page.getByRole("button", {
      name: `Record Subscription for ${subDate}`,
      exact: true,
    });
    const recordGym = page.getByRole("button", { name: `Record Gym for ${gymDate}`, exact: true });
    const skipGym = page.getByRole("button", { name: `Skip Gym for ${gymDate}`, exact: true });

    // Every due occurrence is listed separately, named after its rule and
    // its own date.
    await expect(recordRent).toBeVisible();
    await expect(recordSub).toBeVisible();
    await expect(recordGym).toBeVisible();

    // A due-but-unrecorded occurrence is not yet spending: the hero total
    // is unmoved by three occurrences' worth of amounts sitting in the DUE
    // section.
    await expect(heroTotal(page)).toHaveText("$20.00");

    // Accessibility gate while the DUE section is genuinely populated.
    await expectNoViolations(page, "/ (DUE section populated)");

    // --- Record Rent's occurrence: dated LAST MONTH. ---
    await recordRent.click();
    await expect(recordRent).toHaveCount(0);

    // THE LOAD-BEARING ASSERTION: the resulting transaction is dated to the
    // OCCURRENCE (last month), never to today.
    await page.goto("/transactions");
    const lastMonthSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: dayHeading(lastMonthFirst) }) });
    await expect(lastMonthSection.getByText("Housing", { exact: true })).toBeVisible();
    await expect(lastMonthSection.getByText(`${MINUS}$1,000.00`, { exact: true })).toBeVisible();

    const todaySection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: dayHeading(todayIso) }) });
    await expect(todaySection.getByText("Housing", { exact: true })).toHaveCount(0);

    // Recording last month's rent must NOT inflate THIS month's hero
    // total — it is real history, but not this month's spending.
    await page.goto("/");
    await expect(heroTotal(page)).toHaveText("$20.00");

    // --- Record Subscription's occurrence: dated THIS month (but not today). ---
    await recordSub.click();
    await expect(recordSub).toHaveCount(0);

    await page.goto("/transactions");
    const thisMonthSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: dayHeading(thisMonthFirst) }) });
    await expect(thisMonthSection.getByText("Subscriptions", { exact: true })).toBeVisible();
    await expect(thisMonthSection.getByText(`${MINUS}$100.00`, { exact: true })).toBeVisible();

    // NOW the hero total moves — this occurrence lands inside the current
    // month, so recording it is genuinely this month's spending.
    await page.goto("/");
    await expect(heroTotal(page)).toHaveText("$120.00");

    // --- Skip Gym's occurrence: leaves the due list without a transaction. ---
    await expect(recordGym).toBeVisible();
    await skipGym.click();
    await expect(recordGym).toHaveCount(0);
    await expect(skipGym).toHaveCount(0);

    await page.goto("/transactions");
    await expect(page.getByText("Health", { exact: true })).toHaveCount(0);

    // The skip doesn't move the hero total either.
    await page.goto("/");
    await expect(heroTotal(page)).toHaveText("$120.00");
  });
});
