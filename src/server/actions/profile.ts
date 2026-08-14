"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { Constants } from "@/lib/database.types";
import { THEME_COOKIE_MAX_AGE, THEME_COOKIE_NAME } from "@/lib/theme-cookie";

// Constants.public.Enums.theme_pref is generated from the live `theme_pref`
// Postgres enum (see src/lib/database.types.ts), so this tracks migrations
// automatically instead of a hand-maintained literal that can silently fall
// out of sync with the database (e.g. a future migration adding a fourth
// theme option would need this updated by hand under the old approach).
const themeSchema = z.enum(Constants.public.Enums.theme_pref);

const THEME_COOKIE_OPTIONS = {
  path: "/",
  maxAge: THEME_COOKIE_MAX_AGE,
  sameSite: "lax",
} as const;

/**
 * Persists the caller's theme preference to `profiles.theme` and mirrors it
 * into a `theme` cookie.
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
 *
 * The cookie write (see src/lib/theme-cookie.ts for why a cookie exists at
 * all) is what lets src/app/layout.tsx render `data-theme` on `<html>`
 * without a `getUser()` round trip on every request — `cookies().set()` is
 * only legal here, in a Server Function, per node_modules/next/dist/docs/
 * 01-app/03-api-reference/04-functions/cookies.md ("Setting cookies is not
 * supported during Server Component rendering").
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

  const cookieStore = await cookies();
  cookieStore.set(THEME_COOKIE_NAME, parsed, THEME_COOKIE_OPTIONS);

  revalidatePath("/", "layout");
}

/**
 * Reconciles a stale `theme` cookie with `profiles.theme` — the durable
 * source of truth — when they disagree (e.g. the user changed their theme
 * on another device, and this device's cookie predates that change).
 *
 * Deliberately ignores any client-supplied theme value and re-derives it
 * from Postgres instead: a Server Function is reachable via direct POST
 * (see setTheme's doc comment above), and trusting a caller-supplied theme
 * here would let a raw POST plant an arbitrary (if low-stakes) cookie value
 * without ever touching the database. Called from
 * src/components/shell/ThemeCookieSync.tsx, a small Client Component
 * mounted by the `(app)` layout, because a Server Component (the layout
 * itself) is not allowed to call `cookies().set()` — only a Server Function
 * or Route Handler may, so the reconciliation has to be triggered from a
 * client effect rather than performed inline during the layout's render.
 * See node_modules/next/dist/docs/01-app/02-guides/server-actions.md, which
 * documents invoking a Server Function "from an event handler or `useEffect`
 * wrapped in `startTransition`" as one of the three supported invocation
 * methods.
 *
 * No-ops (skips both the write and the revalidate) when the cookie was
 * already correct, so a component that calls this defensively on every
 * mount doesn't pay for a redundant cookie write or RSC refresh on the
 * common case where nothing has drifted.
 */
export async function syncThemeCookie(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: profile } = await supabase
    .from("profiles")
    .select("theme")
    .eq("id", user.id)
    .single();
  const actual = profile?.theme ?? "system";

  const cookieStore = await cookies();
  if (cookieStore.get(THEME_COOKIE_NAME)?.value === actual) return;

  cookieStore.set(THEME_COOKIE_NAME, actual, THEME_COOKIE_OPTIONS);
  revalidatePath("/", "layout");
}
