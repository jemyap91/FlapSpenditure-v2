import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CategorySection } from "./CategorySection";
import type { Category } from "@/components/CategoryPicker";

/**
 * /categories — the management screen from spec §5.3: "Create, edit,
 * reorder, archive (never hard-delete — it would orphan history)." Editing
 * (renaming, recolouring, changing icon) and reordering are not built here
 * — out of this task's scope, and `createCategory`/`archiveCategory`'s
 * signatures leave room for a future editor to add them without a schema
 * change. Creation and archiving, the two operations this task's
 * verification bar exercises, are both real here (see ./CategorySection.tsx).
 *
 * Categories belong to a WALLET now, not a user (0008) — a caller with two
 * or more wallets no longer has one flat list, so this page needs a wallet
 * selector. `?wallet=<uuid>` is a plain query param, not client state: this
 * stays a Server Component, and the selection is shareable/bookmarkable as
 * a URL. `categories_member` RLS (`is_wallet_member(wallet_id)`) already
 * scopes the categories SELECT to wallets the caller belongs to — no
 * explicit membership filter is needed for the read, unlike the mutations
 * in server/actions/categories.ts, which scope defensively anyway per this
 * branch's established convention.
 *
 * A query error is not "no categories" — every wallet has 16 seeded rows
 * (supabase/migrations/0008_wallet_scoped_categories.sql's
 * `seed_wallet_categories` trigger) by the time it can be selected here at
 * all, so an empty result would always mean the query itself failed, not a
 * legitimate empty state. Throwing lets the nearest error boundary handle
 * it instead of silently rendering two empty sections, matching (app)/
 * layout.tsx's own "never conflate failure with emptiness" reasoning for
 * its wallet count.
 */
export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ wallet?: string }>;
}) {
  const supabase = await createClient();
  const { wallet } = await searchParams;

  const { data: wallets, error: walletsError } = await supabase
    .from("wallets")
    .select("id, name")
    .is("archived_at", null)
    .order("created_at");
  if (walletsError) throw new Error("Failed to load wallets");
  if (!wallets?.length) redirect("/onboarding");

  // An unknown or absent ?wallet falls back to the first rather than
  // erroring: the id comes from a URL a user can edit, and RLS would return
  // an empty list for someone else's wallet anyway.
  const selected = wallets.find((w) => w.id === wallet) ?? wallets[0]!;

  const { data, error } = await supabase
    .from("categories")
    .select("id, name, kind, color_slot, icon, wallet_id")
    .eq("wallet_id", selected.id)
    .is("archived_at", null)
    .order("kind")
    .order("sort_order");
  if (error) throw new Error("Failed to load categories");

  const rows: Category[] = data ?? [];
  const expense = rows.filter((c) => c.kind === "expense");
  const income = rows.filter((c) => c.kind === "income");

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-6 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Categories
      </h1>
      {/* Plain links, not a <select>: this is a Server Component and the
          selection is a URL, so it needs no client JS and is shareable. */}
      <nav aria-label="Choose account" className="mb-6 flex flex-wrap gap-2">
        {wallets.map((w) => (
          <Link
            key={w.id}
            href={`/categories?wallet=${w.id}`}
            aria-current={w.id === selected.id ? "page" : undefined}
            className="rounded-full border px-3 py-1 text-sm"
            style={{
              borderColor: w.id === selected.id ? "var(--cat-1)" : "var(--ink-2)",
              fontWeight: w.id === selected.id ? 600 : 400,
              color: "var(--ink)",
            }}
          >
            {w.name}
          </Link>
        ))}
      </nav>
      <CategorySection kind="expense" label="Expense" initial={expense} walletId={selected.id} />
      <CategorySection kind="income" label="Income" initial={income} walletId={selected.id} />
    </div>
  );
}
