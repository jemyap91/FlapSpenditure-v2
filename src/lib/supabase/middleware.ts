import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/database.types";
import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase/env";
import { isPublicPath } from "@/lib/supabase/public-paths";

/**
 * Refreshes the Supabase session cookie on every request and redirects
 * unauthenticated requests away from protected routes. Invoked from
 * src/proxy.ts (the Next.js 16 successor to middleware.ts — see that file
 * for why).
 */
export async function updateSession(request: NextRequest) {
  // The OAuth / magic-link callback is exempt entirely — not merely allowed
  // through as a public path, but never touched.
  //
  // At that moment the browser holds a PKCE code verifier and NO session.
  // Calling getUser() here fails (correctly — there is nothing to validate
  // yet), and auth-js responds by clearing session cookies via
  // _removeSession(). That sweep can take the verifier cookie with it, so the
  // route handler then exchanges a code whose verifier no longer exists and
  // the user is bounced to /login with "that sign-in link is invalid or has
  // expired" — after a Google flow that succeeded perfectly.
  //
  // isPublicPath() already stops the REDIRECT, but the damage is done before
  // that check: the cookie writes happen inside getUser(). The fix has to be
  // an early return, before the client is constructed.
  //
  // There is nothing to lose by skipping: refreshing a session that does not
  // exist yet is pointless, and the callback establishes one itself moments
  // later. It also removes an auth-server round trip from the flow.
  if (request.nextUrl.pathname.startsWith("/auth/")) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // getUser() revalidates against the auth server; getSession() trusts the
  // cookie and must not be used for authorization decisions.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;

  if (!user && !isPublicPath(path)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    const redirect = NextResponse.redirect(url);
    // `setAll` above may have written cookie deletions onto `response` (e.g.
    // auth-js clearing a stale/invalid session via _removeSession()). A
    // fresh NextResponse.redirect(...) starts with an empty cookie jar, so
    // without this the dead cookie would never be cleared and every
    // subsequent navigation would re-send it, pay another auth-server round
    // trip, and redirect again.
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }
  return response;
}
