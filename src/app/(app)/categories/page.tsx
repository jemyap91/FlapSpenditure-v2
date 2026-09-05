import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CategorySection } from "./CategorySection";
import type { Category } from "@/components/CategoryPicker";

/**
 * /categories — the management screen from spec §5.3: "Create, edit,
 * reorder, archive (never hard-delete — it would orphan history)."
 *
 * Categories belong to a SPACE — a household — since 0022, not to a wallet
 * (0008) and not to a user (0002). That is why this page no longer opens with
 * a row of wallet chips: under wallet scoping "the category list" did not
 * exist, only "this wallet's list" did, so the screen had to ask which one
 * you meant before it could show you anything. With nine wallets that was
 * nine lists of sixteen, a rename touched one copy of nine, and a category
 * created here was not offerable when editing a transaction in a different
 * wallet. There is now one list, so there is nothing to ask.
 *
 * `?space=<uuid>` survives for the uncommon case the chip row existed for in
 * spirit: a user who belongs to two households, which happens only by
 * accepting a wallet invite from outside their own. The selector renders only
 * when there is genuinely a choice to make — one household, no control.
 *
 * `spaces_member` RLS (`is_space_member(id)`) already scopes the spaces read,
 * and `categories_space` (`is_space_member(space_id)`) the categories read, so
 * neither needs an explicit membership filter — unlike the mutations in
 * server/actions/categories.ts, which scope defensively anyway per this
 * branch's established convention.
 *
 * A query error is not "no categories": every space has 16 seeded rows from
 * `seed_space_categories` (0022) by the time it can be selected here at all,
 * so an empty result would always mean the query itself failed, not a
 * legitimate empty state. Throwing lets the nearest error boundary handle it
 * instead of silently rendering two empty sections, matching (app)/layout.tsx's
 * own "never conflate failure with emptiness" reasoning.
 */
export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ space?: string }>;
}) {
  const supabase = await createClient();
  const { space } = await searchParams;

  const { data: spaces, error: spacesError } = await supabase
    .from("spaces")
    .select("id, name")
    .order("created_at");
  if (spacesError) throw new Error("Failed to load households");
  // Every account gets a space from `handle_new_user` (0022), so an empty
  // list here means the session predates that or the account is mid-signup —
  // onboarding is the only screen that can do anything about either.
  if (!spaces?.length) redirect("/onboarding");

  // An unknown or absent ?space falls back to the first rather than erroring:
  // the id comes from a URL a user can edit, and RLS would return an empty
  // list for another household's id anyway.
  const selected = spaces.find((s) => s.id === space) ?? spaces[0]!;

  const { data, error } = await supabase
    .from("categories")
    .select("id, name, kind, color_slot, icon, space_id")
    .eq("space_id", selected.id)
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
      {/* Only when there is a choice. Plain links, not a <select>: this is a
          Server Component and the selection is a URL, so it needs no client
          JS and is shareable. */}
      {spaces.length > 1 && (
        <nav aria-label="Choose household" className="mb-6 flex flex-wrap gap-2">
          {spaces.map((s) => (
            <Link
              key={s.id}
              href={`/categories?space=${s.id}`}
              aria-current={s.id === selected.id ? "page" : undefined}
              className="rounded-full border px-3 py-1 text-sm"
              style={{
                borderColor: s.id === selected.id ? "var(--cat-1)" : "var(--ink-2)",
                fontWeight: s.id === selected.id ? 600 : 400,
                color: "var(--ink)",
              }}
            >
              {s.name}
            </Link>
          ))}
        </nav>
      )}
      <CategorySection kind="expense" label="Expense" initial={expense} spaceId={selected.id} />
      <CategorySection kind="income" label="Income" initial={income} spaceId={selected.id} />
    </div>
  );
}
