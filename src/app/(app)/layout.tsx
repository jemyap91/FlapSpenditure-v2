import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserProfile } from "@/lib/supabase/current-user";
import { Sidebar } from "@/components/shell/Sidebar";
import { TabBar } from "@/components/shell/TabBar";
import { AddFab } from "@/components/shell/AddFab";
import { ThemeCookieSync } from "@/components/shell/ThemeCookieSync";

/**
 * Authenticated app shell: sidebar on desktop, tab bar on mobile. Every
 * route under (app) renders inside this. Two gates run here:
 *
 * 1. No session -> /login. Belt-and-suspenders with src/proxy.ts (which
 *    already redirects unauthenticated requests before this layout ever
 *    renders, per its AUTH_GATE_MATCHER) rather than redundant: per
 *    node_modules/next/dist/docs/01-app/02-guides/data-security.md, the
 *    proxy is an optimistic check, not the authorization boundary, and this
 *    layout is what actually decides what to render.
 * 2. No active (non-archived) wallet -> /onboarding. A brand-new signup has
 *    a profile and default categories (Task 11's trigger) but no wallet
 *    until they complete onboarding (Task 15), so nothing under this shell
 *    has anywhere to write a transaction yet. /onboarding does not exist as
 *    of this task and will 404 until Task 15 lands — expected, not this
 *    task's to fix (carried in Task 13's notes).
 *
 *    IMPORTANT — this redirect only terminates because /onboarding is a
 *    sibling of the `(app)` route group, not a route inside it (Task 15's
 *    directive). This layout has no way to inspect the current pathname
 *    (layouts receive `params`, not the request URL — usePathname() is a
 *    Client Component hook only), so it cannot exempt "am I already on
 *    /onboarding" by checking the path. If /onboarding is ever moved inside
 *    `(app)`, every brand-new signup (zero wallets, redirected here by
 *    auth.ts's signUp) will loop this redirect forever. Do not move
 *    /onboarding under `(app)` without first giving this layout a real way
 *    to exempt it (e.g. a route-group-relative check, or moving the wallet
 *    gate into /onboarding's own siblings instead of this shared layout).
 *
 * getCurrentUserProfile() is the same cache()-memoized call the root layout
 * already made this request, so the redundant getUser() here (needed to
 * `redirect` rather than just render nothing) does not cost a second round
 * trip to the auth server. The wallets count is a separate query — it is
 * not part of "current user" and every other route needs it, not just this
 * one check — so it stays here rather than in the shared helper.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await getCurrentUserProfile();
  if (!profile) redirect("/login");

  const supabase = await createClient();
  const { count, error } = await supabase
    .from("wallets")
    .select("id", { count: "exact", head: true })
    .is("archived_at", null);
  // A query error is not "no wallets" — `count` is `null` on error just as
  // it would be for a legitimately empty result, so destructuring only
  // `{ count }` (the brief's snippet) would send a user to onboarding on a
  // transient DB blip, indistinguishable from a real first-time signup.
  // Never conflate failure with emptiness: throw and let the nearest error
  // boundary handle it instead of silently misrouting the user.
  if (error) throw new Error("Failed to load wallets");
  if (!count) redirect("/onboarding");

  return (
    <div className="min-h-dvh md:flex" style={{ background: "var(--page)" }}>
      {/* Skip link: the nav (Sidebar/TabBar) precedes <main> in DOM order,
          so keyboard users need a way to bypass it. Visually hidden until
          focused (sr-only / focus:not-sr-only), then rendered as a real,
          visible, high-contrast control. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]"
        style={{ background: "var(--surface)", color: "var(--ink)" }}
      >
        Skip to content
      </a>
      {/* No visible output — reconciles a theme cookie that predates a
          theme change made on another device against profile.theme (the
          value just fetched above), so the root layout's <html data-theme>
          self-heals on the next render instead of staying stuck. See
          ThemeCookieSync.tsx for why this can't just happen inline here. */}
      <ThemeCookieSync serverTheme={profile.theme} />
      <Sidebar theme={profile.theme} />
      {/* tabIndex so the skip link above can programmatically focus it,
          without adding <main> itself to the normal Tab order. */}
      <main id="main-content" tabIndex={-1} className="flex-1 pb-20 md:pb-0 focus:outline-none">
        {children}
      </main>
      <AddFab />
      <TabBar />
    </div>
  );
}
