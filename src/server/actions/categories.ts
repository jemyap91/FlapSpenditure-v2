"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { categoryInput, nextColorSlot } from "@/lib/validation/category";
import type { Database } from "@/lib/database.types";

/**
 * File-level `"use server"` (like src/server/actions/{auth,profile,wallets,
 * transactions}.ts), not per-function inline directives — every export
 * below is already an `async function`, so nothing forces the inline form.
 * `nextColorSlot`, the one genuinely synchronous pure helper this task's
 * brief calls for, lives in src/lib/validation/category.ts instead — see
 * that file's doc comment (and src/lib/validation/transaction.ts's
 * `signedAmount`, plus this branch's Task 16 report) for why a file-level
 * directive and a synchronous export cannot coexist in the same file
 * (Turbopack: "Server Actions must be async functions").
 *
 * Server Functions are reachable via direct POST requests, not just
 * through whatever UI calls them (node_modules/next/dist/docs/01-app/
 * 02-guides/server-actions.md, "Security"), so every export below
 * re-derives the caller from the session itself via `getUser()` rather
 * than trusting a client-supplied id, and re-validates its input with zod
 * rather than trusting the caller's static TypeScript type.
 */

type CategoryRow = Pick<
  Database["public"]["Tables"]["categories"]["Row"],
  "id" | "name" | "kind" | "color_slot" | "icon"
>;

export type CategoryResult = { category: CategoryRow } | { error: string };
export type MutationResult = { ok: true } | { error: string };

/**
 * Creates a category for the caller, auto-assigning `color_slot` (via
 * `nextColorSlot`) and `sort_order` (appended to the end) when the input
 * doesn't specify a slot — matching spec §5.3's defaults table exactly:
 * `kind` fixed at creation, `color_slot` auto-assigned but user-overridable,
 * `icon` a curated default, `sort_order` appended, `is_default: false`.
 *
 * `owner_id` is never accepted from the client (`categoryInput` has no such
 * field) — it always comes from `supabase.auth.getUser()`.
 */
export async function createCategory(raw: unknown): Promise<CategoryResult> {
  const parsed = categoryInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { name, kind, icon } = parsed.data;

  // categories_owner (supabase/migrations/0002_wallets_categories.sql) is a
  // partial index on (owner_id, kind) where archived_at is null — exactly
  // this query's shape, so both the colour-slot spread and the
  // sort_order append look only at the caller's own ACTIVE categories of
  // this kind, matching the unique-name index's own active-rows scope.
  const { data: existing, error: existingError } = await supabase
    .from("categories")
    .select("color_slot, sort_order")
    .eq("owner_id", user.id)
    .eq("kind", kind)
    .is("archived_at", null);
  if (existingError) return { error: "Could not create category. Please try again." };

  const colorSlot = parsed.data.color_slot ?? nextColorSlot((existing ?? []).map((c) => c.color_slot));
  const sortOrder = Math.max(0, ...(existing ?? []).map((c) => c.sort_order)) + 1;

  const { data, error } = await supabase
    .from("categories")
    .insert({
      owner_id: user.id,
      name,
      kind,
      color_slot: colorSlot,
      icon,
      sort_order: sortOrder,
      is_default: false,
    })
    .select("id, name, color_slot, icon, kind")
    .single();

  if (error) {
    // categories_unique_active_name is a partial unique index on
    // (owner_id, kind, lower(btrim(name))) where archived_at is null
    // (supabase/migrations/0002_wallets_categories.sql) — case- and
    // whitespace-insensitive, scoped per owner AND per kind, active rows
    // only. 23505 is Postgres's unique_violation SQLSTATE. The message
    // below is app-authored, not the raw provider string (this branch's
    // "never forward raw provider messages" convention, established in
    // wallets.ts/profile.ts to stop an account-enumeration-oracle class of
    // leak — a duplicate-name error carries no such risk itself, but
    // forwarding arbitrary Postgres text is still avoided on principle).
    if (error.code === "23505") return { error: `"${name}" already exists` };
    return { error: "Could not create category. Please try again." };
  }

  // "layout": Task 19's add-transaction screen and this task's own
  // /categories page both need the new row to show up without a hard
  // refresh, and both live under different route segments — invalidating
  // just "/categories" would miss the former.
  revalidatePath("/", "layout");
  return { category: data };
}

/**
 * Archives (never hard-deletes) a category — spec §5.3: "Deleting a
 * category would orphan every transaction referencing it. Archiving hides
 * it from pickers while leaving history intact." Scoped to the caller's
 * own rows in the query itself (`.eq("owner_id", user.id)`), in front of
 * (not instead of) `categories_own` RLS, matching src/server/actions/
 * wallets.ts's `archiveWallet`.
 *
 * Returns a discriminated result rather than throwing — the brief's
 * `Promise<void>` signature was tried on this branch already for the
 * identical shape (src/server/actions/transactions.ts's `setDeletedAt`,
 * Task 16) and reverted: a thrown `Error` inside a Server Function is
 * masked to an opaque digest in production, which would leave a future
 * caller unable to distinguish "not signed in" from "not found" from
 * "update failed." Pre-empting that here rather than waiting for the same
 * review finding to land twice on this branch.
 */
export async function archiveCategory(id: string): Promise<MutationResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { error } = await supabase
    .from("categories")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_id", user.id);
  if (error) return { error: "Could not archive category. Please try again." };

  revalidatePath("/", "layout");
  return { ok: true };
}
