import { createClient } from "@/lib/supabase/server";
import { CategoryBreakdown, type BreakdownRow } from "@/components/CategoryBreakdown";
import { CashFlow, type FlowRow } from "@/components/CashFlow";
import { BudgetSummary } from "@/components/BudgetSummary";
import { formatMoney } from "@/lib/money";
import { monthRange } from "@/lib/month-range";
import type { BudgetStatusRow } from "@/lib/budget-status";

/**
 * Task 21's dashboard — the first thing a returning user sees. Replaces
 * Task 14's placeholder body (`(app)/page.tsx` already existed; Task 14's
 * own doc comment there says exactly this task owns the replacement, and
 * why the route lives here rather than at `src/app/page.tsx` — see that
 * file's history / this task's report for the landmine it avoided).
 *
 * `monthRange` (the current calendar month, inclusive both ends, as LOCAL
 * calendar-date strings) now lives in `@/lib/month-range` — Task 3 of the
 * budgets plan extracted it so budgets and the dashboard share one
 * implementation rather than drifting apart. See that module's doc comment
 * for the timezone rationale (a REVIEW-CAUGHT bug where building the range
 * via `Date.toISOString()` silently shifted it by a day in UTC+ timezones).
 */
export default async function DashboardPage() {
  const supabase = await createClient();
  const { from, to } = monthRange();

  // `created_at` ascending so "the first wallet this user set up" is a
  // deterministic pick, not whatever order Postgres happens to return.
  const { data: wallets, error: walletsError } = await supabase
    .from("wallets")
    .select("id, currency_code, created_at")
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  // A query error is not "no wallets" — same reasoning as (app)/layout.tsx's
  // own wallet-count check: `data` is `null` on error exactly like a
  // legitimate empty result, so skipping this check would render an empty
  // dashboard on a transient DB blip, indistinguishable from a real
  // brand-new account. (In practice the layout gate above this route
  // already redirects any account with zero active wallets to /onboarding,
  // so `wallets` should never legitimately be empty here — but a query
  // FAILURE is still not the same claim as "confirmed empty," so it's
  // still thrown rather than silently coerced to `[]`.)
  if (walletsError) throw new Error("Failed to load wallets");

  const activeWallets = wallets ?? [];
  // Primary currency = the first-created active wallet's currency. Wallets
  // in a DIFFERENT currency are excluded from wallet_ids below — not
  // silently included. `get_category_breakdown` sums `amount_minor` per
  // category with no currency grouping (supabase/migrations/
  // 0006_aggregates.sql): minor units are not comparable across
  // currencies with different exponents (JPY's minor unit is 1 yen, USD's
  // is 1 cent — see src/lib/money.ts's MINOR_UNITS), so summing a JPY
  // wallet's amount_minor into the same total as a USD wallet's would
  // produce a number with no real meaning, then format it as if it were
  // all one currency. Restricting wallet_ids to the primary currency's
  // wallets keeps every number this page renders arithmetically honest.
  // A true multi-currency dashboard (e.g. converted-to-base-currency
  // totals) is out of this task's scope — see this task's report for that
  // limitation; `profiles.base_currency` is NOT used here because nothing
  // in this codebase ever sets it away from its 'USD' default (confirmed:
  // no reference to it in onboarding-form.tsx or wallets.ts), so it would
  // silently mislabel a JPY-only or EUR-only wallet as USD.
  const currency = activeWallets[0]?.currency_code ?? "USD";
  const walletIds = activeWallets.filter((w) => w.currency_code === currency).map((w) => w.id);
  // REVIEW-CAUGHT (Important): excluding non-primary-currency wallets keeps
  // the arithmetic honest (see the comment above), but doing so SILENTLY
  // was itself a defect — a user with both USD and JPY wallets would see a
  // figure captioned only "spent this month" that quietly omits real JPY
  // spend, with nothing on screen saying so. `hasExcludedWallets` drives a
  // caption qualifier below so the omission is disclosed, not just correct.
  const hasExcludedWallets = walletIds.length < activeWallets.length;

  const { data: breakdown, error: breakdownError } = await supabase.rpc(
    "get_category_breakdown",
    { wallet_ids: walletIds, from_date: from, to_date: to },
  );
  // Same "error is not emptiness" rule as the wallets query above, and the
  // one this task's brief calls out by name: `get_category_breakdown`
  // fails CLOSED (empty rows, no error) when `wallet_ids` is empty, null,
  // or contains anything unauthorised — that is a legitimate, silent empty
  // result by the RPC's own design, not a bug to work around here. A
  // Postgres/network failure is a SEPARATE outcome (`error` set, `data`
  // null) and must not render the same "no spending this month" empty
  // state `CategoryBreakdown` shows for a genuinely quiet month.
  if (breakdownError) throw new Error("Failed to load category breakdown");

  // Same fail-open-on-authorised-empty / fail-closed-on-error split as the
  // breakdown RPC above, and the SAME `walletIds`/`from`/`to` — but, per
  // spec §3.3 ("category and income/expense rollups filter `kind <>
  // 'transfer'`; cash flow does not"), `get_cash_flow` deliberately applies
  // no `kind` filter server-side, so a transfer's legs show up here even
  // though they never contribute to `breakdown`/`spent` above. Nothing here
  // adds one back. `bucket` is fixed at "day" — this task's brief and
  // interface (`<CashFlow rows currencyCode />`) don't expose a
  // week/month selector; `week`/`month` were exercised directly against the
  // RPC for this task's verification instead (see this task's report).
  const { data: flow, error: flowError } = await supabase.rpc("get_cash_flow", {
    wallet_ids: walletIds,
    from_date: from,
    to_date: to,
    bucket: "day",
  });
  // Identical reasoning to `breakdownError` above: a Postgres/network
  // failure (`error` set) is not the same claim as "no cash flow this
  // month" (`data: []`, no error) — the two trap warnings called out in this
  // task's brief (a silent UTC round-trip, and an error rendered as an empty
  // state) are both about exactly this class of mistake, so this is checked
  // the same explicit way as every other RPC call on this page.
  if (flowError) throw new Error("Failed to load cash flow");

  // `get_budget_status` takes no `wallet_ids` -- unlike the two RPCs above,
  // it is scoped entirely by RLS (`budget_visible`, 0013_wallet_set_budgets.sql)
  // over every budget the caller can see, across EVERY currency, not just
  // `currency`. `BudgetSummary` itself filters back down to `currency` and to
  // budgets whose wallet set covers every active wallet in it (Task 7's
  // controller addendum §2/§3) -- reusing this page's own already-resolved
  // `currency`/`walletIds.length` rather than resolving a second, possibly-
  // disagreeing notion of "primary currency" or "all wallets" inside that
  // component. Same "error is not emptiness" split as `breakdownError`/
  // `flowError` above.
  const { data: budgetStatus, error: budgetStatusError } = await supabase.rpc("get_budget_status", {
    from_date: from,
    to_date: to,
  });
  if (budgetStatusError) throw new Error("Failed to load budget status");

  const rows: BreakdownRow[] = breakdown ?? [];
  // Same pattern as `rows` above: an explicit type annotation, not an
  // inline `as FlowRow[]` cast. `database.types.ts` already types
  // `get_cash_flow`'s return shape identically to `FlowRow` (regenerated
  // from the RPC's own `returns table(...)` clause), so a cast here would
  // buy nothing and would silence a genuine mismatch if that generated type
  // ever drifted from `FlowRow` — the sibling `rows` line doesn't cast, and
  // review-caught (small) this shouldn't either.
  const flowRows: FlowRow[] = flow ?? [];
  const budgetRows: BudgetStatusRow[] = budgetStatus ?? [];
  // REVIEW-CAUGHT (small): this used to be recomputed a second time inside
  // CategoryBreakdown from the same `rows` array — two independent sums of
  // the same data that could only ever agree by construction, never by a
  // guarantee. `spent` is now the ONE place this sum is computed; it drives
  // the hero figure directly and is passed down as `total` so the bar's
  // percentage math uses the exact same number instead of re-deriving it.
  const spent = rows.reduce((s, r) => s + r.total_minor, 0);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <header>
        {/* An `<h1>`, not a `<p>`: this page had no level-one heading at
            all, so its first heading was CategoryBreakdown's `<h2>` and
            the document outline started at level 2 (caught by axe's
            `page-has-heading-one` in e2e/ledger.spec.ts — a best-practice
            rule, which is why the WCAG A/AA gate never flagged it).
            Promoting the month rather than adding a hidden title keeps the
            heading something a sighted user can actually see, and the
            month IS what this dashboard is scoped to — every figure below
            is "this month". Tag only; the classes are unchanged, so
            nothing moves. */}
        <h1
          className="text-sm font-medium uppercase tracking-wide"
          style={{ color: "var(--ink-2)" }}
        >
          {new Date().toLocaleString("en-US", { month: "long", year: "numeric" })}
        </h1>
        {/* Hero figure: >=48px, system sans, proportional figures (§6.4).
            `total_minor` here is a SUM of already-positive per-category
            magnitudes (get_category_breakdown's own `sum(-t.amount_minor)`),
            so this is a plain, unsigned money render — no double negation,
            no `{ signed: true }` (there is nothing to sign; this is always
            an amount spent, never a balance that can go negative). */}
        <p className="text-5xl font-semibold" style={{ color: "var(--ink)" }}>
          {formatMoney(spent, currency)}
        </p>
        {/* REVIEW-CAUGHT (Important): the caption now says WHICH wallets
            this figure covers whenever some were excluded (different
            currency), rather than reading as a total that silently isn't
            one. Unqualified whenever every active wallet shares one
            currency — the common case, and the only case the un-qualified
            text was ever accurate for. */}
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          spent this month{hasExcludedWallets ? ` · ${currency} wallets` : ""}
        </p>
      </header>
      <CategoryBreakdown rows={rows} currencyCode={currency} total={spent} />
      <CashFlow rows={flowRows} currencyCode={currency} hasExcludedWallets={hasExcludedWallets} />
      <BudgetSummary rows={budgetRows} currencyCode={currency} walletCount={walletIds.length} />
    </div>
  );
}
