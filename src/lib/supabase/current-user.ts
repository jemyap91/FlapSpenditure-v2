import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";

export type ThemePref = Database["public"]["Enums"]["theme_pref"];

export type CurrentUserProfile = {
  id: string;
  theme: ThemePref;
  /** The person's own default currency. Used to seed the currency select
   *  when they have no wallets yet to infer one from. */
  base_currency: string;
  /** How this person orders their own wallets list — "manual", "name" or
   *  "created" (0019_wallet_groups.sql). Typed as plain `string` because the
   *  column is a CHECK rather than an enum, so the generated types cannot
   *  narrow it; /wallets validates it with `walletSortInput` before use. */
  wallet_sort: string;
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
    .select("theme, base_currency, wallet_sort")
    .eq("id", user.id)
    .single();

  // 'USD' mirrors the column's own default (0001_reference.sql), so a
  // missing profile row degrades to the same value the database would have
  // supplied rather than to an arbitrary one.
  return {
    id: user.id,
    theme: profile?.theme ?? "system",
    base_currency: profile?.base_currency ?? "USD",
    // Mirrors the column default for the same reason as base_currency above.
    wallet_sort: profile?.wallet_sort ?? "manual",
  };
});
