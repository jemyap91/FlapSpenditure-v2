import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * OAuth / magic-link callback. Exchanges the `code` query param Supabase
 * appends to the redirect URL for a session, then sends the user on.
 *
 * This route is deliberately EXEMPT from the session proxy — see the early
 * return in src/lib/supabase/middleware.ts. At this point the browser holds a
 * PKCE code verifier and no session, so running getUser() here would fail and
 * auth-js would clear cookies, potentially taking the verifier with it and
 * making the exchange below fail for a reason nothing surfaces.
 *
 * Every failure is logged with its actual cause. The user still sees one
 * generic message — the provider's own text is not something to render — but
 * "invalid or expired" with no server-side detail is unfalsifiable in
 * production, and this route had exactly that problem the first time it was
 * exercised end to end.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);

  // Supabase appends these when the provider itself refused (consent denied,
  // misconfigured client, and so on). They never reached the log before, so a
  // provider-side failure looked identical to a failed code exchange.
  const providerError = searchParams.get("error");
  const providerErrorDescription = searchParams.get("error_description");
  if (providerError) {
    console.error("[auth/callback] provider returned an error", {
      error: providerError,
      description: providerErrorDescription,
    });
    return NextResponse.redirect(`${origin}/login?error=auth`);
  }

  const code = searchParams.get("code");
  if (!code) {
    console.error("[auth/callback] no code parameter on the callback URL");
    return NextResponse.redirect(`${origin}/login?error=auth`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    // The message distinguishes the cases that actually happen: a missing or
    // mismatched PKCE verifier (cookie cleared, different origin, different
    // project) reads differently from a code that was already redeemed.
    console.error("[auth/callback] exchangeCodeForSession failed", {
      message: error.message,
      status: error.status,
      code: error.code,
    });
    return NextResponse.redirect(`${origin}/login?error=auth`);
  }

  return NextResponse.redirect(`${origin}/`);
}
