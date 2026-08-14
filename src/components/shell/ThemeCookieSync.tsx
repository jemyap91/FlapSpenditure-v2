"use client";

import { useEffect, useTransition } from "react";
import { syncThemeCookie } from "@/server/actions/profile";
import { THEME_COOKIE_NAME } from "@/lib/theme-cookie";
import type { ThemePref } from "@/lib/supabase/current-user";

function readThemeCookie(): string | undefined {
  return document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${THEME_COOKIE_NAME}=`))
    ?.split("=")[1];
}

/**
 * Renders nothing. Mounted once by the `(app)` layout to reconcile a stale
 * `theme` cookie with `profiles.theme` (the value the layout already fetched
 * server-side, via getCurrentUserProfile) when they disagree — e.g. the
 * theme was changed on another device, and this device's cookie predates
 * that change.
 *
 * Why this is a Client Component doing a client-side comparison, not a
 * check in the `(app)` layout itself: `cookies().set()` throws outside a
 * Server Function or Route Handler (node_modules/next/dist/docs/01-app/
 * 03-api-reference/04-functions/cookies.md — "Cookies can only be modified
 * in a Server Action or Route Handler"), so the layout — a Server Component
 * — cannot write the corrected cookie during its own render no matter how
 * it detects the mismatch. This component's effect runs post-hydration and
 * fires the syncThemeCookie Server Function (server-actions.md documents
 * `useEffect` wrapped in `startTransition` as one of the three supported
 * invocation methods), which both corrects the cookie and revalidates the
 * root layout, so `<html data-theme>` self-heals on the very next render
 * without the user doing anything.
 *
 * The common case (cookie already matches) costs one `document.cookie`
 * string read and no network request.
 */
export function ThemeCookieSync({ serverTheme }: { serverTheme: ThemePref }) {
  const [, start] = useTransition();

  useEffect(() => {
    if (readThemeCookie() === serverTheme) return;
    start(() => {
      void syncThemeCookie().catch(() => {});
    });
  }, [serverTheme]);

  return null;
}
