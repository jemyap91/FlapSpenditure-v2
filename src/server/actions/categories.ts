"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { categoryInput, categoryEditInput, nextColorSlot } from "@/lib/validation/category";
import type { Database } from "@/lib/database.types";

// Not exported: a file-level "use server" directive requires every EXPORT
// to be async, but a plain internal const is invisible to that boundary —
// it never leaves this module. Re-validates `archiveCategory`'s `id`
// parameter the same way `categoryInput` re-validates `createCategory`'s
// body: a Server Function is reachable via direct POST with any string,
// not just a real uuid a `<button onClick>` would ever produce, and this
// file's own doc comment already commits to "re-validate rather than trust
// the caller's static type" — an untyped-but-assumed-uuid `id: string`
// parameter was the one place that promise wasn't kept.
const idSchema = z.uuid();

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
  // `wallet_id` is part of the row on purpose, not incidentally: a
  // category belongs to a wallet (0008), and both callers of
  // `createCategory` merge the returned row into a client-side list that
  // is filtered by the CURRENTLY selected wallet. Without this column the
  // returned row could not be told apart from another wallet's, which is
  // exactly how a wallet-A category ended up selectable under wallet B —
  // and how `as Category` casts (now removed) papered over the gap.
  "id" | "name" | "kind" | "color_slot" | "icon" | "wallet_id"
>;

export type CategoryResult = { category: CategoryRow } | { error: string };
export type MutationResult = { ok: true } | { error: string };

/**
 * Creates a category for a wallet, auto-assigning `color_slot` (via
 * `nextColorSlot`) and `sort_order` (appended to the end) when the input
 * doesn't specify a slot — matching spec §5.3's defaults table exactly:
 * `kind` fixed at creation, `color_slot` auto-assigned but user-overridable,
 * `icon` a curated default, `sort_order` appended.
 *
 * `wallet_id` comes from `categoryInput` (client-supplied, since a category
 * is not tied to a single user — 0008) but the caller's *membership* in that
 * wallet is never taken on trust: it is re-derived from `getUser()` and
 * checked against `wallet_members` below, so a raw POST naming someone
 * else's wallet_id is rejected before any query touches `categories`.
 */
export async function createCategory(raw: unknown): Promise<CategoryResult> {
  const parsed = categoryInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { wallet_id } = parsed.data;

  // Membership, not ownership: an invited member may create categories in a
  // shared wallet (spec §Decisions — equal on money). RLS enforces this too;
  // this check is so the action can return a readable message rather than a
  // policy violation.
  const { data: membership } = await supabase
    .from("wallet_members")
    .select("wallet_id")
    .eq("wallet_id", wallet_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) return { error: "You do not have access to that wallet." };

  // Colour slots spread within the WALLET now, so two members of one wallet
  // never collide, and two wallets never constrain each other.
  const { data: existing } = await supabase
    .from("categories")
    .select("color_slot, sort_order")
    .eq("wallet_id", wallet_id)
    .is("archived_at", null);

  const colorSlot = parsed.data.color_slot ?? nextColorSlot((existing ?? []).map((c) => c.color_slot));

  const { data, error } = await supabase
    .from("categories")
    .insert({
      wallet_id,
      name: parsed.data.name,
      kind: parsed.data.kind,
      color_slot: colorSlot,
      icon: parsed.data.icon,
      sort_order: (existing?.length ?? 0) + 1,
    })
    .select("id, name, color_slot, icon, kind, wallet_id")
    .single();

  if (error) {
    // categories_unique_active_name is a partial unique index on
    // (wallet_id, kind, lower(btrim(name))) where archived_at is null
    // (supabase/migrations/0008_wallet_scoped_categories.sql) — case- and
    // whitespace-insensitive, scoped per wallet AND per kind, active rows
    // only. 23505 is Postgres's unique_violation SQLSTATE. The message
    // below is app-authored, not the raw provider string (this branch's
    // "never forward raw provider messages" convention, established in
    // wallets.ts/profile.ts to stop an account-enumeration-oracle class of
    // leak — a duplicate-name error carries no such risk itself, but
    // forwarding arbitrary Postgres text is still avoided on principle).
    if (error.code === "23505") return { error: `"${parsed.data.name}" already exists` };
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
 * it from pickers while leaving history intact." Scoped to `id` alone in
 * the query itself, unlike `createCategory`'s explicit membership check:
 * categories no longer carry an owner column to filter on (0008), and
 * `categories_member` RLS (`is_wallet_member(wallet_id)`) is what actually
 * stops a non-member's UPDATE from matching any row, matching
 * src/server/actions/wallets.ts's `archiveWallet`'s "RLS is the real gate,
 * the app-level filter is defense in depth" shape — here RLS is the ONLY
 * gate, since there is nothing left in this table for the query itself to
 * filter on.
 *
 * Returns a discriminated result rather than throwing — the brief's
 * `Promise<void>` signature was tried on this branch already for the
 * identical shape (src/server/actions/transactions.ts's `setDeletedAt`,
 * Task 16) and reverted: a thrown `Error` inside a Server Function is
 * masked to an opaque digest in production, which would leave a future
 * caller unable to distinguish "not signed in" from "not found" from
 * "update failed." Pre-empting that here rather than waiting for the same
 * review finding to land twice on this branch.
 *
 * The `UPDATE` is filtered to `.is("archived_at", null)` and its own
 * affected-row count is checked (`.select("id")`, then `data.length`) —
 * without this, a nonexistent id, a non-member's id (RLS makes that UPDATE
 * match zero rows, which is not an error in Postgres), or an
 * already-archived row would all silently return `{ ok: true }` with the
 * database left exactly as it was, and the caller (this task's
 * CategorySection, or a future one) would remove the row from its local
 * list on a lie. Same shape as src/server/actions/transactions.ts's
 * `setDeletedAt` (Task 16), which counts affected rows for the identical
 * reason — see that function's doc comment.
 */
/**
 * Renames / recolours / re-icons an existing category. Name, colour and icon
 * are the whole of it — see `categoryEditInput`'s doc comment for what is
 * deliberately not here and why the database now refuses those columns too
 * (supabase/migrations/0018_category_update_grant.sql).
 *
 * No membership lookup of its own, matching `archiveCategory` rather than
 * `createCategory`: `categories_member` RLS scopes this UPDATE to wallets the
 * caller belongs to, so a foreign id already affects zero rows and lands on
 * "Category not found". `createCategory` needs its explicit `wallet_members`
 * check because an INSERT's `with check` alone cannot distinguish "not a
 * member" from a malformed row, and it wants the readable message.
 *
 * `.is("archived_at", null)` for the same reason `updateTransaction` filters
 * on `deleted_at`: an archived category is not offered anywhere in the UI,
 * and editing one directly would be an unstated asymmetry with archive
 * itself. The filter is on the UPDATE, not a preceding SELECT, so an archive
 * racing this edit lands on "not found" rather than a stray write.
 *
 * A wallet being archived is deliberately NOT checked, matching
 * `archiveCategory`'s existing behaviour rather than `updateTransaction`'s:
 * renaming a category inside a wallet you have archived changes no money and
 * no balance, and inventing a refusal here that archive itself does not make
 * would be a new asymmetry rather than a removed one.
 */
export async function updateCategory(raw: unknown): Promise<MutationResult> {
  const parsed = categoryEditInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { id, name, color_slot, icon } = parsed.data;

  const { data, error } = await supabase
    .from("categories")
    .update({ name, color_slot, icon })
    .eq("id", id)
    .is("archived_at", null)
    .select("id");

  if (error) {
    // `categories_unique_active_name` is unique on (wallet_id, kind,
    // lower(btrim(name))) among ACTIVE rows, so renaming onto a sibling's
    // name raises 23505. Same message shape `createCategory` already uses
    // for the identical collision — a driver error would reach the user as
    // "Could not save", which says nothing about the one thing they can fix.
    if (error.code === "23505") return { error: `"${name}" already exists` };
    return { error: "Could not save category. Please try again." };
  }
  if (!data || data.length === 0) return { error: "Category not found" };

  revalidatePath("/", "layout");
  return { ok: true };
}

export async function archiveCategory(id: string): Promise<MutationResult> {
  const parsedId = idSchema.safeParse(id);
  // Deliberately the same "not found" message a real-but-nonexistent id
  // gets below, not "invalid id" — nothing distinguishes a malformed id
  // from one that simply doesn't belong to this caller, and there's no
  // reason to give an adversarial caller a way to tell those apart.
  if (!parsedId.success) return { error: "Category not found" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { data, error } = await supabase
    .from("categories")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", parsedId.data)
    .is("archived_at", null)
    .select("id");
  if (error) return { error: "Could not archive category. Please try again." };
  if (!data || data.length === 0) return { error: "Category not found" };

  revalidatePath("/", "layout");
  return { ok: true };
}
