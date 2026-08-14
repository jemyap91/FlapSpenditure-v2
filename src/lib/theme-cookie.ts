import { Constants } from "@/lib/database.types";
import type { Database } from "@/lib/database.types";

export type ThemePref = Database["public"]["Enums"]["theme_pref"];

/**
 * Carries the caller's theme preference outside the session, so the root
 * layout can render `data-theme` on `<html>` from a cookie read alone —
 * no `getUser()` round trip, no Postgres query — instead of blocking the
 * very first byte of every route (including public ones like /login) on
 * an auth check that's only load-bearing for the `(app)` route group.
 *
 * Theme is not sensitive, so a cookie is an appropriate carrier for it;
 * `profiles.theme` in Postgres stays the durable source of truth. Written
 * by setTheme() (src/server/actions/profile.ts) and, when it drifts from
 * `profiles.theme` (e.g. changed from another device), reconciled by
 * syncThemeCookie() via src/components/shell/ThemeCookieSync.tsx. Not
 * `httpOnly`: the sync component reads it client-side via `document.cookie`
 * to decide whether reconciliation is needed, without a network round trip.
 *
 * No "server-only" import here (unlike src/lib/supabase/current-user.ts):
 * this module is imported by both a Server Component (the root layout) and
 * a Client Component (ThemeCookieSync), and neither `THEME_COOKIE_NAME` nor
 * `isThemePref` touches any server-only API.
 */
export const THEME_COOKIE_NAME = "theme";

/** One year: long enough that a returning user's explicit choice survives, short enough to eventually self-heal if a device is never revisited. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const THEME_VALUES: readonly string[] = Constants.public.Enums.theme_pref;

export function isThemePref(value: string | undefined): value is ThemePref {
  return value !== undefined && THEME_VALUES.includes(value);
}
