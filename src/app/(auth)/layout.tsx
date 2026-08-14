import { redirect } from "next/navigation";
import { getCurrentUserProfile } from "@/lib/supabase/current-user";

/**
 * Bounces an already-authenticated caller away from /login and /signup.
 *
 * Carried from Task 13: src/lib/supabase/public-paths.ts's isPublicPath
 * deliberately lets authenticated requests through to these pages (so an
 * expired-but-not-yet-refreshed session doesn't get bounced mid-render),
 * and neither page itself checked for a session — so a signed-in user could
 * land on the login form and re-submit signIn.
 *
 * This belongs in a layout scoped to the (auth) route group rather than:
 *  - the proxy (src/proxy.ts): per node_modules/next/dist/docs/01-app/
 *    01-getting-started/16-proxy.md, Proxy is for fast, optimistic routing
 *    decisions ("not intended for slow data fetching... should not be used
 *    as a full session management or authorization solution"). It already
 *    does one getUser() round trip per request for the unauthenticated-gate
 *    check; duplicating authenticated-user logic there doubles that for
 *    every request site-wide, not just the two auth pages.
 *  - the pages themselves: login/page.tsx and signup/page.tsx (a Server
 *    Component and a Client Component respectively) would each need their
 *    own copy of this check, and Task 13's own carry-forward note flags
 *    those two files as already 67 near-identical lines apart — adding a
 *    third copy of an auth check is the wrong direction.
 *
 * A layout is exactly the tool for "shared behavior across a route group's
 * pages" and reuses the same cached getCurrentUserProfile() the (app)
 * layout and root layout already call this request, so this adds no extra
 * round trip beyond what's already paid for.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const profile = await getCurrentUserProfile();
  if (profile) redirect("/");
  return children;
}
