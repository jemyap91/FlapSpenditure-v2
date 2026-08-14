"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const themeSchema = z.enum(["system", "light", "dark"]);

/**
 * Persists the caller's theme preference to `profiles.theme`.
 *
 * Server Functions are reachable via direct POST requests, not just through
 * the UI that calls them (see node_modules/next/dist/docs/01-app/02-guides/
 * data-security.md, "Authentication and authorization"), so this re-derives
 * the caller from the session itself — never trusts a client-supplied id —
 * and validates `theme` against the enum rather than passing an arbitrary
 * string through to Postgres. `theme` is typed `string`, not the narrower
 * `'system' | 'light' | 'dark'`, precisely because a raw POST can send
 * anything; the zod parse is what actually narrows it, and `.parse` throws
 * (with a message that never reaches the client body beyond a generic
 * Server Action error) on anything outside the enum.
 *
 * RLS's `profiles_own` policy (`id = auth.uid()`) already stops this from
 * writing another user's row — but that is the backstop, not the only
 * check: the explicit `.eq("id", user.id)` here is what makes the UPDATE
 * target the caller's row deliberately, rather than relying on RLS to save
 * a query that forgot to scope itself.
 */
export async function setTheme(theme: string): Promise<void> {
  const parsed = themeSchema.parse(theme);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase.from("profiles").update({ theme: parsed }).eq("id", user.id);
  if (error) throw new Error("Failed to update theme");

  revalidatePath("/", "layout");
}
