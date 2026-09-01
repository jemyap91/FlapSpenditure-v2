import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createRule, updateRule } from "@/server/actions/recurring";
import type { Category } from "@/components/CategoryPicker";
import { RecurringForm } from "./RecurringForm";
import { RecurringList, type RecurringRuleRow } from "./RecurringList";

/**
 * /recurring — Task 5's management screen: create, edit and pause recurring
 * rules. The dashboard's "due" list (Task 6) is a separate, later screen —
 * per this task's brief, it disappears whenever nothing is due, which is
 * exactly when a user goes looking to CREATE a rule, so it cannot be the
 * only entry point here. This route is linked from /transactions instead
 * (see that page's own doc comment) and deliberately NOT added to the
 * TabBar/Sidebar nav — the mobile tab bar was just cut from six items to
 * five to stop wallet names truncating, and this route has its own
 * permanent link already.
 *
 * Three RLS-scoped reads, issued together, matching (app)/wallets/page.tsx's
 * own convention: no explicit membership filter is needed for any of them
 * (`wallets_select`/`categories_member`/`recurring_rules_member` already
 * scope each to wallets the caller belongs to), but every mutation in
 * src/server/actions/recurring.ts scopes defensively anyway, per this
 * branch's established convention.
 *
 * A query error is not "nothing recurring" — thrown, not swallowed, so the
 * nearest error boundary handles it instead of rendering the empty state on
 * a transient database blip, matching every other Server Component read in
 * this codebase (wallets/page.tsx, categories/page.tsx, transactions/
 * page.tsx all document the identical reasoning).
 *
 * `categories` is fetched UNFILTERED by wallet — unlike /categories, which
 * takes a `?wallet=` query param and narrows its own select to one wallet —
 * because RecurringForm's wallet control can point at any of the caller's
 * wallets, and switching it needs that wallet's categories already in hand
 * on the client (see RecurringForm's own `walletCategories` filter).
 *
 * `wallets`/`categories`(name, color_slot, icon) are embedded on the
 * `recurring_rules` read via their plain FKs (`recurring_rules_wallet_id_
 * fkey`, `recurring_rules_category_same_wallet`) — each is the ONLY
 * relationship from `recurring_rules` to that table (confirmed against
 * src/lib/database.types.ts's generated `Relationships`), unlike
 * transactions' embed of `categories`, which needs an explicit `!fkey` hint
 * to resolve a genuine ambiguity that does not exist here.
 */
export default async function RecurringPage() {
  const supabase = await createClient();

  const [
    { data: wallets, error: walletsError },
    { data: categories, error: categoriesError },
    { data: rules, error: rulesError },
  ] = await Promise.all([
    supabase
      .from("wallets")
      .select("id, name, currency_code")
      .is("archived_at", null)
      .order("created_at"),
    supabase
      .from("categories")
      .select("id, name, kind, color_slot, icon, wallet_id")
      .is("archived_at", null),
    supabase
      .from("recurring_rules")
      .select(
        "id, wallet_id, name, kind, amount_minor, currency_code, category_id, interval_unit, anchor_on, ends_on, wallets(name), categories(name, color_slot, icon)",
      )
      .is("archived_at", null)
      .order("created_at"),
  ]);

  if (walletsError) throw new Error("Failed to load wallets");
  if (categoriesError) throw new Error("Failed to load categories");
  if (rulesError) throw new Error("Failed to load recurring rules");

  // (app)/layout.tsx already redirects a caller with zero active wallets to
  // /onboarding before this page ever renders — this is defence in depth,
  // matching /categories's identical redirect, not a real path: a rule
  // cannot exist without a wallet, and RecurringForm needs at least one to
  // offer at all.
  if (!wallets?.length) redirect("/onboarding");

  // Supabase types embedded relations loosely — asserted ONCE here, at the
  // data boundary, matching /transactions's identical `JoinedTxn` pattern,
  // rather than casting inline inside the map below.
  type JoinedRule = {
    id: string;
    wallet_id: string;
    name: string;
    kind: "expense" | "income";
    amount_minor: number;
    currency_code: string;
    category_id: string;
    interval_unit: RecurringRuleRow["interval_unit"];
    anchor_on: string;
    ends_on: string | null;
    wallets: { name: string } | null;
    categories: { name: string; color_slot: number; icon: string } | null;
  };

  const rows: RecurringRuleRow[] = ((rules ?? []) as unknown as JoinedRule[]).map((r) => ({
    id: r.id,
    wallet_id: r.wallet_id,
    wallet_name: r.wallets?.name ?? "",
    name: r.name,
    kind: r.kind,
    amount_minor: r.amount_minor,
    currency_code: r.currency_code,
    category_id: r.category_id,
    category_name: r.categories?.name ?? null,
    category_icon: r.categories?.icon ?? null,
    color_slot: r.categories?.color_slot ?? null,
    interval_unit: r.interval_unit,
    anchor_on: r.anchor_on,
    ends_on: r.ends_on,
  }));

  const walletRows = wallets.map((w) => ({ id: w.id, name: w.name, currency_code: w.currency_code }));
  const categoryRows = (categories ?? []) as unknown as Category[];

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-6 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Recurring
      </h1>

      <RecurringList
        rules={rows}
        wallets={walletRows}
        categories={categoryRows}
        /* Bound ACTIONS, not rendered forms — same reasoning as /wallets's
           identical `editActions`: RecurringList already holds every
           rule's data, so handing it the capability rather than the markup
           lets it render the form itself and know when a save succeeded,
           closing its own dialog. No ownership gate here, unlike
           /wallets's owner-only Edit: `recurring_rules` has no per-user
           ownership column, and `recurring_rules_member` RLS is
           member-writable by design (0015's own comment) — every rule on
           this page is one any viewer here may edit. */
        editActions={Object.fromEntries(rows.map((r) => [r.id, updateRule.bind(null, r.id)]))}
      />

      <section aria-labelledby="add-rule-heading" className="mt-8">
        <h2
          id="add-rule-heading"
          className="mb-3 text-sm font-medium uppercase tracking-wide"
          style={{ color: "var(--ink-2)" }}
        >
          Add a recurring rule
        </h2>
        <RecurringForm
          action={createRule}
          submitLabel="Add rule"
          pendingLabel="Adding…"
          wallets={walletRows}
          categories={categoryRows}
          defaultWalletId={walletRows[0]!.id}
        />
      </section>
    </div>
  );
}
