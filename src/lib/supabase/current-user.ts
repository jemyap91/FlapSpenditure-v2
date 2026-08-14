import "server-only";
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
 * per request. Two Server Components need "who is this and what's their
 * theme" on every request — the `(auth)` layout (redirect-if-already-
 * authenticated) and the `(app)` layout (the auth gate itself, plus the
 * value passed to ThemeToggle and used to reconcile the theme cookie via
 * ThemeCookieSync). Without this, each would run its own `getUser()` +
 * `profiles` round trip for the same request. React's `cache()` memoizes a
 * zero-arg call within a single render pass (see node_modules/next/dist/docs/
 * 01-app/03-api-reference/03-file-conventions/layout.md, "Fetching Data"),
 * so the underlying Supabase calls happen once per request rather than up
 * to twice.
 *
 * The root layout deliberately does NOT call this — see src/app/layout.tsx
 * and src/lib/theme-cookie.ts for why it reads only a cookie instead: this
 * function makes a real GoTrue network round trip, and blocking the first
 * byte of every route (public auth pages included) on it, when the proxy
 * already pays that same round trip, was a review finding on this task.
 *
 * Returns null when there is no session — never throws for that case.
 * Callers decide whether the absence of a user is fatal (both `(app)` and
 * `(auth)` layouts redirect on null).
 *
 * `import "server-only"` above: this module is exclusively imported for its
 * async function today (never re-exported as a value into a Client
 * Component), so nothing currently breaks without it — but a future
 * `import { getCurrentUserProfile }` from a Client Component would silently
 * drag `next/headers` (via createClient -> cookies()) toward the client
 * bundle and fail with an unhelpful bundler error. `server-only` turns that
 * into an immediate, clear build-time error instead.
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
