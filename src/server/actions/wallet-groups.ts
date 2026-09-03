"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  walletGroupInput,
  walletGroupEditInput,
  walletGroupAssignInput,
  walletOrderInput,
  walletSortInput,
} from "@/lib/validation/wallet-group";
import type { Database } from "@/lib/database.types";

/**
 * Per-user grouping and ordering of the wallets list (0019_wallet_groups.sql).
 *
 * File-level `"use server"`, matching the other action modules here, so every
 * export below is `async`. Each one re-derives the caller from the session
 * rather than accepting a user id, and re-validates its input with zod rather
 * than trusting the caller's static type: a Server Function is reachable by
 * direct POST regardless of what the UI offers.
 *
 * None of these touch the `wallets` table. Grouping and ordering are one
 * user's private view of a SHARED object, so writing them into `wallets`
 * would let one household member rearrange another's screen — the reason
 * 0019 puts them in their own per-user tables at all.
 */

type GroupRow = Pick<
  Database["public"]["Tables"]["wallet_groups"]["Row"],
  "id" | "name" | "sort_order"
>;

export type GroupResult = { group: GroupRow } | { error: string };
export type MutationResult = { ok: true } | { error: string };

const idSchema = z.uuid();

/** Every mutation here changes what the wallets screen renders, and that
 *  screen is a Server Component reading these tables — so each one has to
 *  invalidate, exactly as the category and transaction actions do. */
function refresh() {
  revalidatePath("/", "layout");
}

export async function createWalletGroup(raw: unknown): Promise<GroupResult> {
  const parsed = walletGroupInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  // Appended to the end of the user's own groups. `count` rather than
  // max(sort_order) + 1 would collide after a delete; reading the current
  // maximum keeps ordering stable across the gaps a delete leaves behind.
  const { data: last } = await supabase
    .from("wallet_groups")
    .select("sort_order")
    .eq("user_id", user.id)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await supabase
    .from("wallet_groups")
    .insert({
      user_id: user.id,
      name: parsed.data.name,
      sort_order: (last?.sort_order ?? -1) + 1,
    })
    .select("id, name, sort_order")
    .single();

  if (error) {
    // wallet_groups_unique_name is unique on (user_id, lower(btrim(name))).
    if (error.code === "23505") return { error: `"${parsed.data.name}" already exists` };
    return { error: "Could not create that group. Please try again." };
  }
  refresh();
  return { group: data };
}

export async function renameWalletGroup(raw: unknown): Promise<MutationResult> {
  const parsed = walletGroupEditInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  // No `.eq("user_id", ...)`: `wallet_groups_own` already scopes this to the
  // caller's own rows, so another user's group id affects zero rows and lands
  // on "not found" — the same message a genuinely absent id gets, since
  // nothing should distinguish those two for an adversarial caller.
  const { data, error } = await supabase
    .from("wallet_groups")
    .update({ name: parsed.data.name })
    .eq("id", parsed.data.id)
    .select("id");

  if (error) {
    if (error.code === "23505") return { error: `"${parsed.data.name}" already exists` };
    return { error: "Could not rename that group. Please try again." };
  }
  if (!data || data.length === 0) return { error: "Group not found" };
  refresh();
  return { ok: true };
}

/**
 * Deletes a group. The wallets in it are NOT deleted and their arrangement
 * is not lost: `wallet_prefs.group_id` is `on delete set null (group_id)`
 * (0019), the PG15+ column-list form, so those rows keep their `sort_order`
 * and simply return to the ungrouped list. The bare `set null` form would
 * have nulled every referencing column, which here means `user_id` too — a
 * NOT NULL column, so the delete would have failed instead.
 */
export async function deleteWalletGroup(id: string): Promise<MutationResult> {
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return { error: "Group not found" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { data, error } = await supabase
    .from("wallet_groups")
    .delete()
    .eq("id", parsedId.data)
    .select("id");

  if (error) return { error: "Could not delete that group. Please try again." };
  if (!data || data.length === 0) return { error: "Group not found" };
  refresh();
  return { ok: true };
}

/**
 * Files one wallet into a group, or (with `group_id: null`) out of every
 * group.
 *
 * Through `set_wallet_group` (0021_wallet_prefs_upsert.sql) rather than
 * PostgREST's own `.upsert()`. A user has no `wallet_prefs` row for a wallet
 * until they first arrange it, so this has to be insert-or-update — but
 * `.upsert()` compiles the update half to a SET list naming EVERY column
 * supplied, `user_id` and `wallet_id` included, and 0019 grants UPDATE on
 * `(group_id, sort_order)` only. The result was a first grouping that
 * worked and every later one failing with a permission error. The function
 * issues the same statement with a SET list naming only `group_id`, and is
 * `security invoker`, so `wallet_prefs_own` and the column grants apply to
 * it exactly as they would here.
 *
 * Two things the caller cannot do here even by direct POST: file a wallet
 * into someone ELSE's group (wallet_prefs_group_same_user, the composite FK
 * on (group_id, user_id)), or record a preference about a wallet they are
 * not a member of (`wallet_prefs_own`'s `with check`).
 */
export async function setWalletGroup(raw: unknown): Promise<MutationResult> {
  const parsed = walletGroupAssignInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { error } = await supabase.rpc("set_wallet_group", {
    p_wallet_id: parsed.data.wallet_id,
    p_group_id: parsed.data.group_id ?? undefined,
  });

  if (error) {
    // 23503 is the composite FK refusing a group that isn't this user's;
    // 42501 / an RLS refusal is the `with check` refusing a wallet they
    // cannot see. Both mean the same thing to an honest caller, whose UI
    // only ever offers their own groups and their own wallets.
    if (error.code === "23503") return { error: "That group no longer exists" };
    return { error: "Could not move that wallet. Please try again." };
  }
  refresh();
  return { ok: true };
}

/**
 * Records a manual ordering as the complete list of wallet ids.
 *
 * One statement for the whole list rather than one per wallet, so the
 * ordering lands atomically and cannot be left half-renumbered by a dropped
 * connection midway. Through `set_wallet_order`
 * (0021_wallet_prefs_upsert.sql) rather than PostgREST's `.upsert()`, for
 * the reason `setWalletGroup` above documents: `.upsert()`'s update half
 * names every supplied column, including the two that make up the primary
 * key and are deliberately not grantable.
 */
export async function setWalletOrder(raw: unknown): Promise<MutationResult> {
  const parsed = walletOrderInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const ids = parsed.data.wallet_ids;
  // A duplicate id would make one wallet's position ambiguous AND make the
  // upsert touch the same primary key twice in one statement, which Postgres
  // refuses outright ("ON CONFLICT DO UPDATE command cannot affect row a
  // second time") — an error message about nothing the user did.
  if (new Set(ids).size !== ids.length) return { error: "That ordering repeats a wallet" };

  const { error } = await supabase.rpc("set_wallet_order", { p_wallet_ids: ids });

  if (error) return { error: "Could not save that order. Please try again." };
  refresh();
  return { ok: true };
}

/** Which of the three orderings the user's list uses. Stored on `profiles`
 *  rather than per device, so it follows them. */
export async function setWalletSort(raw: unknown): Promise<MutationResult> {
  const parsed = walletSortInput.safeParse(raw);
  if (!parsed.success) return { error: "That sort order isn't available" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { error } = await supabase
    .from("profiles")
    .update({ wallet_sort: parsed.data })
    .eq("id", user.id);

  if (error) return { error: "Could not save that preference. Please try again." };
  refresh();
  return { ok: true };
}
