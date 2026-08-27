import { createClient } from "@/lib/supabase/server";
import { getCurrentUserProfile } from "@/lib/supabase/current-user";
import { monthRange } from "@/lib/month-range";
import { BudgetList, type BudgetWallet } from "./BudgetList";
import { MONTH_NAME } from "@/lib/month-names";
import type { BudgetStatusRow } from "@/lib/budget-status";

/**
 * /budgets — this month's spending against each wallet SET's overall cap and
 * per-category budgets (spec 2026-08-25; migration 0013). Follows the same
 * Server Component fetch + Client Component interactivity split as
 * (app)/wallets/page.tsx (WalletList/MembersSection) and (app)/categories/
 * page.tsx (CategorySection): the queries live here, the amount form,
 * Save/Remove/pickers live in BudgetList.tsx.
 *
 * FOUR reads, not one — `get_budget_status` alone is not enough for this
 * screen, for two independent reasons the controller addendum for this task
 * spells out:
 *
 * 1. `scopeLabel` needs, per BUDGET ROW, the count of the caller's ACTIVE
 *    wallets in THAT ROW'S OWN currency, to decide whether a wallet set truly
 *    covers "All accounts" or merely used to (a set is materialised at
 *    creation, so a wallet added afterward is never covered). That number
 *    cannot come from `rows`, which describes only BUDGETED wallets, so a
 *    plain `wallets` read supplies it — passed down whole; `BudgetList`
 *    itself indexes it by currency (fix round I3: an earlier version of this
 *    page computed one flat "primary currency" count here, which produced a
 *    false "All accounts" for any budget row in a DIFFERENT currency — e.g.
 *    a wallet set shared with a co-member whose own wallets use a currency
 *    other than this viewer's `base_currency`).
 * 2. `get_budget_status`'s own row carries `wallet_names` (display strings)
 *    and never wallet ids (see BudgetList.tsx's own doc comment on
 *    `walletIdsByBudget`). Resubmitting an EXISTING budget's amount through
 *    `set_budget` needs its real wallet ids — `set_budget`'s read-modify-
 *    write match is keyed on the id SET, not on names — so this page also
 *    reads `budget_wallets` directly for every budget id `get_budget_status`
 *    returned. `budget_wallets` is `grant select` to `authenticated` under
 *    `budget_wallets_member` (`is_wallet_member(wallet_id)`), so this is a
 *    plain RLS-scoped read, the same trust boundary every other read on this
 *    page already sits behind.
 *
 * A fourth read (`categories`) backs the new-budget Category picker with
 * every expense category across the primary-currency wallets, not only
 * categories with spending this month — otherwise a wallet with no spending
 * yet offered no way to budget it at all (controller addendum §4).
 */
export default async function BudgetsPage() {
  const supabase = await createClient();
  const profile = await getCurrentUserProfile();
  // (app)/layout.tsx already redirects to /login when there is no session,
  // before this page ever renders — defence in depth, matching every other
  // Server Component's identical guard in this app (e.g. wallets/page.tsx).
  if (!profile) throw new Error("Not signed in");

  const { from, to } = monthRange();

  const [
    { data: rowsData, error: rowsError },
    { data: walletsData, error: walletsError },
  ] = await Promise.all([
    supabase.rpc("get_budget_status", { from_date: from, to_date: to }),
    supabase
      .from("wallets")
      .select("id, name, currency_code")
      .is("archived_at", null)
      .order("created_at"),
  ]);

  // A query error is not "no budgets"/"no accounts" — data is null either
  // way, so rendering an empty state here would present a transient failure
  // as "you have nothing budgeted". Thrown, matching every other Server
  // Component in this app.
  if (rowsError) throw new Error("Failed to load budgets");
  if (walletsError) throw new Error("Failed to load wallets");

  const rows = (rowsData ?? []) as BudgetStatusRow[];
  const wallets: BudgetWallet[] = walletsData ?? [];
  // Primary currency = the first-created active wallet's currency — the
  // SAME rule (app)/page.tsx already uses (spec §4: the two screens MUST
  // agree), never `profile.base_currency`. `profile.base_currency` is
  // NEVER written away from its 'USD' default anywhere in this codebase
  // (confirmed: no reference to it in onboarding-form.tsx or wallets.ts,
  // same check (app)/page.tsx's own doc comment records) — using it here
  // meant an SGD (or any non-USD) user's `primaryWallets` was ALWAYS empty,
  // which skipped the categories query, rendered a wallet picker with zero
  // checkboxes, and made every submit send `walletIds: []`, refused
  // forever by budgetInput's `.min(1)` with no explanation on screen
  // (B1, whole-branch review — the worst defect on this branch). `wallets`
  // is already ordered by `created_at` and filtered to active, identical to
  // the dashboard's own query, so this is the same computation, not a
  // near-miss of it.
  const primaryCurrency = wallets[0]?.currency_code ?? profile.base_currency;
  // Only used for the categories query below now — `BudgetList` derives its
  // own per-CURRENCY wallet counts from the full `wallets` list (fix round
  // I3: a flat "primary currency only" count produced a false "All accounts"
  // for a budget row in a different currency, reachable via a shared wallet
  // whose set spans another member's own currency).
  const primaryWallets = wallets.filter((w) => w.currency_code === primaryCurrency);

  const budgetIds = rows
    .map((r) => r.budget_id)
    .filter((id): id is string => id !== null);

  const [
    { data: budgetWalletsData, error: budgetWalletsError },
    { data: categoriesData, error: categoriesError },
  ] = await Promise.all([
    // Only queried when there is at least one budget id — an empty `.in()`
    // array is a valid, always-empty PostgREST filter, but skipping the
    // round trip entirely when there is nothing to look up is cheaper and
    // avoids depending on that edge-case behaviour at all.
    budgetIds.length > 0
      ? supabase.from("budget_wallets").select("budget_id, wallet_id").in("budget_id", budgetIds)
      : Promise.resolve({ data: [] as { budget_id: string; wallet_id: string }[], error: null }),
    // Same "skip an empty .in()" guard as above, and for the same reason.
    // `primaryCurrency` is always `wallets[0]`'s own currency when there is
    // at least one active wallet (see its derivation above), so
    // `primaryWallets` is empty only when `wallets` itself is — the
    // layout gate ahead of this route already redirects a zero-wallet
    // account to /onboarding, so this branch exists for the same
    // "error is not emptiness, but still not fatal" defensiveness every
    // other guard on this page uses, not a reachable everyday case.
    primaryWallets.length > 0
      ? supabase
          .from("categories")
          .select("name, wallet_id")
          .in("wallet_id", primaryWallets.map((w) => w.id))
          .eq("kind", "expense")
          .is("archived_at", null)
          .order("name")
      : Promise.resolve({ data: [] as { name: string; wallet_id: string }[], error: null }),
  ]);

  if (budgetWalletsError) throw new Error("Failed to load budget accounts");
  if (categoriesError) throw new Error("Failed to load categories");

  const walletIdsByBudget: Record<string, string[]> = {};
  for (const bw of budgetWalletsData ?? []) {
    const list = walletIdsByBudget[bw.budget_id] ?? [];
    list.push(bw.wallet_id);
    walletIdsByBudget[bw.budget_id] = list;
  }

  // Distinct expense category names across the primary-currency wallets,
  // keyed the same way `set_budget`/`get_budget_status` normalise a
  // category (`lower(btrim(name))`, 0013's own `category_key` column
  // comment) so two wallets' "Groceries" and "groceries " collapse to one
  // picker entry rather than two. The FIRST (alphabetically, since the
  // query is `.order("name")`) display spelling wins — mirrors
  // `get_budget_status`'s own `coalesce((select min(name) ...))` label
  // resolution, so the picker's wording matches what an existing budget row
  // over the same category already shows.
  const categoryByKey = new Map<string, string>();
  for (const c of categoriesData ?? []) {
    const key = c.name.trim().toLowerCase();
    if (!categoryByKey.has(key)) categoryByKey.set(key, c.name);
  }
  const categories = Array.from(categoryByKey, ([key, label]) => ({ key, label }));

  // Derived from `from` (the exact window just queried) by string slicing,
  // never a second, independent `new Date()` — see month-range.ts's own doc
  // comment: a request straddling local midnight could otherwise label a
  // window it did not query. `from` is always "YYYY-MM-01".
  const monthLabel = `${MONTH_NAME[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-1 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Budgets
      </h1>
      <p className="mb-1 text-sm" style={{ color: "var(--ink-2)" }}>
        {monthLabel} · expenses only
      </p>
      {/* Spec §5 (bold) and §9: a UI that does not say budgets can overlap
          reads as a bug, not a feature — the same expense can legitimately
          appear under several rows at once (e.g. a category row AND the
          overall cap both count it), and an overall cap does not suppress
          the uncovered rows beneath it either. B3, whole-branch review. */}
      <p className="mb-6 text-sm" style={{ color: "var(--ink-2)" }}>
        Budgets can overlap — spending counted here can appear in more than one row.
      </p>
      <BudgetList
        rows={rows}
        wallets={wallets}
        primaryCurrency={primaryCurrency}
        categories={categories}
        walletIdsByBudget={walletIdsByBudget}
        currentPeriodStart={from}
      />
    </div>
  );
}
