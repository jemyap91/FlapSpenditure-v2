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
 * `categories_own` RLS (`for all ... owner_id = auth.uid()`) already scopes
 * this SELECT to the caller's own rows — no explicit `.eq("owner_id", ...)`
 * is needed for a read, unlike the mutations in server/actions/categories.ts,
 * which scope defensively anyway per this branch's established convention.
 *
 * A query error is not "no categories" — every user has 16 seeded rows
 * (supabase/migrations/0007_seed_user.sql) by the time they can reach this
 * route at all (the (app) layout only renders past onboarding), so an empty
 * result here would always mean the query itself failed, not a legitimate
 * empty state. Throwing lets the nearest error boundary handle it instead
 * of silently rendering two empty sections, matching (app)/layout.tsx's own
 * "never conflate failure with emptiness" reasoning for its wallet count.
 */
export default async function CategoriesPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("categories")
    .select("id, name, kind, color_slot, icon")
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
      <CategorySection kind="expense" label="Expense" initial={expense} />
      <CategorySection kind="income" label="Income" initial={income} />
    </div>
  );
}
