import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";

export type ThemePref = Database["public"]["Enums"]["theme_pref"];

export type CurrentUserProfile = {
  id: string;
  theme: ThemePref;
};

/**
 * Resolves the authenticated caller's id and theme preference at most once
 * per request. Three Server Components need "who is this and what's their
 * theme" on every request — the root layout (sets `data-theme` on `<html>`
 * so there's no flash of the wrong theme), the `(auth)` layout
 * (redirect-if-already-authenticated), and the `(app)` layout (the auth
 * gate itself, plus the value passed to ThemeToggle). Without this, each of
 * the three would run its own `getUser()` + `profiles` round trip for the
 * same request. React's `cache()` memoizes a zero-arg call within a single
 * render pass (see node_modules/next/dist/docs/01-app/api-reference/
 * 03-file-conventions/layout.md, "Fetching Data"), so the underlying
 * Supabase calls happen once per request rather than up to three times.
 *
 * Returns null when there is no session — never throws for that case.
 * Callers decide whether the absence of a user is fatal (the `(app)` and
 * `(auth)` layouts redirect) or fine (the root layout falls back to the
 * 'system' theme for logged-out pages).
 */
export const getCurrentUserProfile = cache(async (): Promise<CurrentUserProfile | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("theme")
    .eq("id", user.id)
    .single();

  return { id: user.id, theme: profile?.theme ?? "system" };
});
