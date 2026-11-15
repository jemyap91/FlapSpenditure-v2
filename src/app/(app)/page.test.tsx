// src/app/(app)/page.test.tsx
//
// Fix round 1 (task-6, I8): spec §7 ("Due/handled computation... a deleted
// transaction returning its occurrence to due") lists this as required
// coverage. `due-rows.test.ts` already proves `buildDueRows` treats a
// handled date as still-due once it's no longer in the `recorded` set it's
// handed — but nothing proved page.tsx's OWN query (`.is("deleted_at",
// null)`) actually keeps a soft-deleted transaction's occurrence out of that
// set in the first place. Three sibling routes (budgets/page.test.tsx,
// transactions/new/page.test.tsx, wallets/[id]/page.test.tsx) already carry
// a page.test.tsx, so this is local convention, not a new pattern.
//
// `@/lib/supabase/server` is mocked before this page module loads —
// budgets/page.test.tsx's own precedent: the real `createClient` reaches
// `next/headers`, which throws outside a request scope, and `npm test` runs
// with no `.env.local` in any case.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

// `DueList` (rendered by this page) imports `shortDate` from
// `RecurringList.tsx`, which imports `archiveRule` from
// `@/server/actions/recurring` and, via `RecurringForm`, `createCategory`
// from `@/server/actions/categories` — both "use server" modules that
// import `@/lib/supabase/server`, which throws at import time outside a
// configured environment. Same mocks, same reasoning, as
// DueList.test.tsx's own.
vi.mock("@/server/actions/recurring", () => ({
  recordOccurrence: vi.fn(),
  skipOccurrence: vi.fn(),
}));
vi.mock("@/server/actions/categories", () => ({
  createCategory: vi.fn(),
}));

const { loadCardTracker } = vi.hoisted(() => ({ loadCardTracker: vi.fn() }));
// `loadCardTracker` is covered by its own suite; here only the page's use of
// it matters (and the real module imports "server-only").
vi.mock("@/server/card-tracker", () => ({ loadCardTracker }));

// src/server/people.ts imports "server-only", which throws outside a Server
// Component build.
vi.mock("server-only", () => ({}));

// The viewer, for the household-members lookup's "You" fallback.
vi.mock("@/lib/supabase/current-user", () => ({
  getCurrentUserProfile: async () => ({ id: "u-c", theme: "system", base_currency: "SGD", wallet_sort: "manual" }),
}));

const { walletsData, rulesData, skipsData, transactionsData, rpcCalls, budgetData } = vi.hoisted(() => ({
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  budgetData: [] as Record<string, unknown>[],
  walletsData: [] as {
    id: string;
    currency_code: string;
    created_at: string;
    owner_id: string;
    shared_with_household: boolean;
  }[],
  rulesData: [] as Record<string, unknown>[],
  skipsData: [] as { rule_id: string; occurrence_on: string }[],
  transactionsData: [] as {
    recurring_id: string | null;
    occurred_on: string;
    recurring_occurrence_on: string;
    deleted_at: string | null;
  }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      // Every RPC this page calls (`get_category_breakdown`,
      // `get_cash_flow`, `get_budget_status`) is irrelevant to the due-list
      // question this file tests — a quiet, error-free empty result for all
      // three keeps the rest of the page's own "error is not emptiness"
      // checks satisfied without asserting anything about them here.
      if (["get_category_breakdown", "get_cash_flow"].includes(name)) {
        return { data: [], error: null };
      }
      if (name === "get_budget_status") return { data: budgetData, error: null };
      if (name === "get_space_members") {
        return {
          data: [
            { space_id: "s1", user_id: "u-c", display_name: "Cheryl", role: "owner", joined_at: "2026-01-01" },
            { space_id: "s1", user_id: "u-j", display_name: "Jeremy", role: "member", joined_at: "2026-01-02" },
          ],
          error: null,
        };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    from: (table: string) => {
      if (table === "wallets") {
        const builder = {
          select: () => builder,
          is: () => builder,
          order: () => builder,
          then: (resolve: (v: { data: typeof walletsData; error: null }) => void) =>
            resolve({ data: walletsData, error: null }),
        };
        return builder;
      }
      if (table === "recurring_rules") {
        const builder = {
          select: () => builder,
          order: () => builder,
          then: (resolve: (v: { data: typeof rulesData; error: null }) => void) =>
            resolve({ data: rulesData, error: null }),
        };
        return builder;
      }
      if (table === "recurring_skips") {
        const builder = {
          select: () => builder,
          gte: () => builder,
          then: (resolve: (v: { data: typeof skipsData; error: null }) => void) =>
            resolve({ data: skipsData, error: null }),
        };
        return builder;
      }
      if (table === "transactions") {
        // Applies its filters FOR REAL against `transactionsData`, rather
        // than ignoring them like the simpler tables above — this table's
        // `deleted_at is null` filter is the exact behaviour this test
        // exists to prove page.tsx's own query preserves, not just
        // `buildDueRows`'s (already covered in due-rows.test.ts).
        let excludeNullRecurringId = false;
        let requireDeletedAtNull = false;
        // Named for the COLUMN page.tsx now bounds and selects on
        // (0016_editable_transactions.sql / fix round 1, CRITICAL 2):
        // `recurring_occurrence_on`, the occurrence's SCHEDULED-date
        // identity, not `occurred_on` (the actual date money moved, edited
        // independently). `occurred_on` still lives on each row below
        // purely so tests can prove the two diverging doesn't matter.
        let occurrenceOnGte: string | undefined;
        // The columns page.tsx actually asked for. Task 7: this used to be
        // ignored, and `then` below returned a fixed
        // `{recurring_id, recurring_occurrence_on}` shape no matter what —
        // which meant the date-edit test below "failed" under a mutation
        // that mapped `occurred_on` only because the value came back
        // `undefined`, not because the wrong DATE was used. Projecting the
        // requested columns (what PostgREST does) makes that mutation
        // produce the real "2026-09-03" and the test catch it for the
        // reason it claims to.
        let selected: string[] = [];
        const builder = {
          select: (cols: string) => {
            selected = cols.split(",").map((c) => c.trim());
            return builder;
          },
          not: (col: string, op: string, val: unknown) => {
            if (col === "recurring_id" && op === "is" && val === null) excludeNullRecurringId = true;
            return builder;
          },
          is: (col: string, val: unknown) => {
            if (col === "deleted_at" && val === null) requireDeletedAtNull = true;
            return builder;
          },
          gte: (col: string, val: string) => {
            if (col === "recurring_occurrence_on") occurrenceOnGte = val;
            return builder;
          },
          then: (resolve: (v: { data: Record<string, unknown>[]; error: null }) => void) => {
            let rows = transactionsData;
            if (excludeNullRecurringId) rows = rows.filter((r) => r.recurring_id !== null);
            if (requireDeletedAtNull) rows = rows.filter((r) => r.deleted_at === null);
            if (occurrenceOnGte) rows = rows.filter((r) => r.recurring_occurrence_on >= occurrenceOnGte!);
            resolve({
              data: rows.map((r) =>
                Object.fromEntries(selected.map((c) => [c, (r as unknown as Record<string, unknown>)[c]])),
              ),
              error: null,
            });
          },
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import DashboardPage from "./page";

const WALLET_ID = "11111111-1111-4111-8111-111111111111";
const RULE_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  walletsData.length = 0;
  rulesData.length = 0;
  skipsData.length = 0;
  transactionsData.length = 0;
  rpcCalls.length = 0;
  budgetData.length = 0;
  loadCardTracker.mockResolvedValue([]);

  walletsData.push({
    id: WALLET_ID,
    currency_code: "SGD",
    created_at: "2026-01-01T00:00:00Z",
    owner_id: "u-c",
    shared_with_household: false,
  });
  rulesData.push({
    id: RULE_ID,
    name: "Rent",
    kind: "expense",
    amount_minor: -150000,
    currency_code: "SGD",
    interval_unit: "monthly",
    anchor_on: "2026-09-01",
    ends_on: null,
    archived_at: null,
    wallets: { name: "Everyday", currency_code: "SGD", archived_at: null },
    categories: { kind: "expense", archived_at: null },
  });

  // Pins `todayLocalDate()` to a known calendar date — same reasoning and
  // same construction (LOCAL components, read back via LOCAL getters) as
  // `recurring.test.ts`'s identical `beforeEach`: both sides of the round
  // trip run in whatever timezone the test machine is in, so they always
  // agree regardless of what that timezone actually is.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 1, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DashboardPage — due list (I8: a deleted transaction returns its occurrence to due)", () => {
  it("still offers Record for an occurrence whose only transaction was soft-deleted", async () => {
    // A transaction WAS recorded for 1 September's rent, then deleted
    // (TransactionList's own undo-based deletion) — `deleted_at` is set,
    // not null. The occurrence must come back to due, not stay hidden
    // behind a transaction that no longer counts.
    transactionsData.push({
      recurring_id: RULE_ID,
      occurred_on: "2026-09-01",
      recurring_occurrence_on: "2026-09-01",
      deleted_at: "2026-08-20T00:00:00Z",
    });

    const ui = await DashboardPage();
    render(ui);

    expect(screen.getByRole("button", { name: "Record Rent for 1 Sep" })).toBeInTheDocument();
  });

  /**
   * Fix round 1 (0016 fix round 1, CRITICAL 2): the migration's whole
   * reason for existing (spec §1.2) — verbatim the scenario the reviewer
   * proved live before this fix: page.tsx still selected/mapped
   * `occurred_on` for the handled set, so correcting a paid date away from
   * its scheduled date un-recorded the occurrence and offered it as due
   * again. 1 September's rent is recorded (`recurring_occurrence_on`
   * stays "2026-09-01", its identity), but the money actually moved on the
   * 3rd (`occurred_on` = "2026-09-03") — a user-initiated date edit,
   * post-Record. The Record button must NOT reappear.
   */
  it("still treats an occurrence as handled after its actual paid date is edited away from its scheduled identity", async () => {
    transactionsData.push({
      recurring_id: RULE_ID,
      occurred_on: "2026-09-03",
      recurring_occurrence_on: "2026-09-01",
      deleted_at: null,
    });

    const ui = await DashboardPage();
    render(ui);

    expect(screen.queryByRole("button", { name: "Record Rent for 1 Sep" })).not.toBeInTheDocument();
  });
});

describe("DashboardPage — viewing another month (?month=)", () => {
  const render_ = async (month?: string) =>
    render(await DashboardPage({ searchParams: Promise.resolve(month ? { month } : {}) }));

  it("queries and labels the requested earlier month", async () => {
    await render_("2026-08");

    expect(screen.getByRole("heading", { level: 2, name: "Spent in August 2026" })).toBeInTheDocument();
    for (const name of ["get_category_breakdown", "get_cash_flow", "get_budget_status"]) {
      expect(rpcCalls.find((c) => c.name === name)?.args).toMatchObject({
        from_date: "2026-08-01",
        to_date: "2026-08-31",
      });
    }
    expect(screen.getByText("spent in August 2026")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Transactions in August 2026" })).toHaveAttribute(
      "href",
      "/transactions?from=2026-08-01&to=2026-08-31",
    );
  });

  it("links back and forth, with the current month as the plain /", async () => {
    await render_("2026-08");

    expect(screen.getByRole("link", { name: "Previous month, July 2026" })).toHaveAttribute(
      "href",
      "/?month=2026-07",
    );
    expect(screen.getByRole("link", { name: "Next month, September 2026" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Back to this month" })).toHaveAttribute("href", "/");
  });

  it("hides what's due when looking back, since that is about today", async () => {
    await render_("2026-08");

    expect(screen.queryByRole("button", { name: "Record Rent for 1 Sep" })).not.toBeInTheDocument();
  });

  it("shows the current month with no next link by default", async () => {
    await render_();

    expect(screen.getByRole("heading", { level: 2, name: "Spent in September 2026" })).toBeInTheDocument();
    expect(screen.getByText("spent this month")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Previous month, August 2026" })).toHaveAttribute(
      "href",
      "/?month=2026-08",
    );
    expect(screen.queryByRole("link", { name: /^Next month/ })).not.toBeInTheDocument();
  });

  it("clamps a future or malformed month to the current one", async () => {
    for (const month of ["2026-10", "2026-13", "nope"]) {
      rpcCalls.length = 0;
      const { unmount } = await render_(month);
      expect(screen.getByRole("heading", { level: 2, name: "Spent in September 2026" })).toBeInTheDocument();
      expect(rpcCalls.find((c) => c.name === "get_cash_flow")?.args).toMatchObject({ from_date: "2026-09-01" });
      unmount();
    }
  });
});

describe("DashboardPage — hero pace against the overall budget", () => {
  const overall = {
    budget_id: "b0",
    category_id: null,
    category_label: null,
    currency_code: "SGD",
    wallet_names: ["Everyday"],
    wallet_count: 1,
    spent_minor: 0,
    budget_minor: 300000,
    budget_period_start: "2026-09-01",
  };

  it("has one level-one heading, the greeting", async () => {
    render(await DashboardPage());
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Hey, you two"]);
  });

  it("shows the budget, days left and pace when an overall budget covers every wallet", async () => {
    budgetData.push(overall);
    render(await DashboardPage());
    // 1 Sep of a 30-day month: 29 days after today, nothing spent yet, so
    // under pace by the first day's share (3000 / 30).
    expect(screen.getByText(/of SGD 3,000\.00 budget · 29 days left/)).toBeInTheDocument();
    expect(screen.getByText("SGD 100.00 under pace")).toBeInTheDocument();
    // The overall budget is the hero's, so it is not repeated as a ring.
    expect(screen.queryByText("Overall budget")).not.toBeInTheDocument();
  });

  it("leaves pace out with no overall budget", async () => {
    render(await DashboardPage());
    expect(screen.queryByText(/under pace|over pace/)).not.toBeInTheDocument();
  });
});

describe("DashboardPage — card to watch", () => {
  const minSpend = {
    walletId: WALLET_ID,
    walletName: "Yuu Card",
    currency: "SGD",
    bonusChannel: null,
    capMinor: 80000,
    from: "2026-08-24",
    to: "2026-09-23",
    spentMinor: 54020,
    remainingMinor: 25980,
    pace: "under",
    mismatchCount: 0,
  };

  it("names the most urgent card, with its owner, and links to the Cards tab", async () => {
    loadCardTracker.mockResolvedValue([minSpend]);
    render(await DashboardPage());

    expect(screen.getByRole("heading", { name: "Card to watch" })).toBeInTheDocument();
    expect(screen.getByText("Yuu Card")).toBeInTheDocument();
    expect(screen.getByText("SGD 259.80 to min spend · 23 days left")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Cheryl" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cards tab" })).toHaveAttribute("href", "/cards");
  });

  it("shows no card block when nothing needs attention", async () => {
    loadCardTracker.mockResolvedValue([{ ...minSpend, spentMinor: 80000, remainingMinor: 0, pace: "reached" }]);
    render(await DashboardPage());
    expect(screen.queryByRole("heading", { name: "Card to watch" })).not.toBeInTheDocument();
  });

  it("measures today's cycle even while browsing an earlier month", async () => {
    await DashboardPage({ searchParams: Promise.resolve({ month: "2026-09" }) });
    expect(loadCardTracker).toHaveBeenCalledWith(expect.anything(), { on: "2026-09-01", today: "2026-09-01" });
    loadCardTracker.mockClear();
    await DashboardPage({ searchParams: Promise.resolve({ month: "2026-08" }) });
    expect(loadCardTracker).toHaveBeenCalledWith(expect.anything(), { on: "2026-09-01", today: "2026-09-01" });
  });

  it("fails the page when the tracker read fails", async () => {
    loadCardTracker.mockRejectedValue(new Error("Failed to load card tracker"));
    await expect(DashboardPage()).rejects.toThrow("Failed to load card tracker");
  });
});
