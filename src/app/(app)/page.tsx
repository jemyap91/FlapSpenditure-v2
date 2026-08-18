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
 * Current calendar month, inclusive both ends, as LOCAL calendar-date
 * strings built directly — never via `Date.toISOString()`.
 *
 * REVIEW-CAUGHT (Critical): the first version of this function built
 * `from`/`to` with `new Date(y, m, 1)` (a LOCAL midnight) and then read it
 * back with `.toISOString().slice(0, 10)` (a UTC re-interpretation). In any
 * UTC+ timezone that silently shifts the whole window backward by one day:
 * on this codebase's own dev machine (Asia/Singapore, UTC+8),
 * `new Date(2026,7,1).toISOString().slice(0,10)` is `"2026-07-31"`, not
 * `"2026-08-01"`. `occurred_on` (supabase/migrations/0003_transactions.sql)
 * is a plain `date` column with no time zone — a LOCAL calendar date — so
 * that shifted window silently counted a 31 July expense into "August" and
 * dropped a 31 August expense from it, while the header below still read
 * "August 2026". This is the exact bug class `TransactionForm.tsx`'s
 * `todayLocalDate()` doc comment exists to warn about (Task 19), on the
 * INPUT side of the same local/UTC round-trip this function was doing on
 * the OUTPUT side. Fixed by never constructing a `Date` for the boundary
 * values at all — `y`/`m`/`last` are plain numbers, and the returned
 * strings are built by direct interpolation, so there is no local-midnight-
 * to-UTC step for a UTC+ offset to corrupt.
 *
 * Residual, deliberately NOT fixed here (flagged, not solved): this still
 * matches the SERVER's calendar month/day, not necessarily the actual
 * viewer's — a request straddling local midnight in a timezone far from
 * the server's could still see a one-day-off window, and the `:93` header
 * label (`new Date().toLocaleString(...)`, also evaluated server-side) has
 * the identical exposure. A real fix needs the viewer's timezone to reach
 * the server (a client-set cookie, an `Intl`-derived offset sent up, or a
 * profile-level timezone field — none of which exist in this schema
 * today) and is out of this task's scope; see this task's report.
 */
function monthRange(now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11
  const lastDay = new Date(y, m + 1, 0).getDate(); // still a Date, but only
  // ever used for its LOCAL getDate() — never round-tripped through
  // toISOString(), so it carries no UTC-shift risk.
  return {
    from: `${y}-${pad(m + 1)}-01`,
    to: `${y}-${pad(m + 1)}-${pad(lastDay)}`,
  };
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

  const rows: BreakdownRow[] = breakdown ?? [];
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
    </div>
  );
}
