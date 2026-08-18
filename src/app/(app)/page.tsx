import { createClient } from "@/lib/supabase/server";
import { CategoryBreakdown, type BreakdownRow } from "@/components/CategoryBreakdown";
import { formatMoney } from "@/lib/money";

/**
 * Task 21's dashboard — the first thing a returning user sees. Replaces
 * Task 14's placeholder body (`(app)/page.tsx` already existed; Task 14's
 * own doc comment there says exactly this task owns the replacement, and
 * why the route lives here rather than at `src/app/page.tsx` — see that
 * file's history / this task's report for the landmine it avoided).
 *
 * Current calendar month, inclusive both ends. `to` is the LAST day of the
 * month (`new Date(y, m + 1, 0)` — day 0 of next month is the last day of
 * this one), not "today," so a user looking back mid-month still sees the
 * whole month's range in one query rather than the range silently growing
 * as the day advances (a stable, whole-period boundary matches what
 * `get_category_breakdown`'s `between from_date and to_date` expects).
 */
function monthRange(now = new Date()) {
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

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
  // silently mislabel a JPY-only or EUR-only account as USD.
  const currency = activeWallets[0]?.currency_code ?? "USD";
  const walletIds = activeWallets.filter((w) => w.currency_code === currency).map((w) => w.id);

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

  const rows: BreakdownRow[] = breakdown ?? [];
  const spent = rows.reduce((s, r) => s + r.total_minor, 0);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <header>
        <p
          className="text-sm font-medium uppercase tracking-wide"
          style={{ color: "var(--ink-2)" }}
        >
          {new Date().toLocaleString("en-US", { month: "long", year: "numeric" })}
        </p>
        {/* Hero figure: >=48px, system sans, proportional figures (§6.4).
            `total_minor` here is a SUM of already-positive per-category
            magnitudes (get_category_breakdown's own `sum(-t.amount_minor)`),
            so this is a plain, unsigned money render — no double negation,
            no `{ signed: true }` (there is nothing to sign; this is always
            an amount spent, never a balance that can go negative). */}
        <p className="text-5xl font-semibold" style={{ color: "var(--ink)" }}>
          {formatMoney(spent, currency)}
        </p>
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          spent this month
        </p>
      </header>
      <CategoryBreakdown rows={rows} currencyCode={currency} />
    </div>
  );
}
