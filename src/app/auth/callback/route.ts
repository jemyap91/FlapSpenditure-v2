import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * OAuth / magic-link callback. Exchanges the `code` query param Supabase
 * appends to the redirect URL for a session, then sends the user on. Not
 * used by the email/password flow in this task (signIn/signUp establish a
 * session directly), but required so a future OAuth provider or magic-link
 * flow (emailRedirectTo pointing here) has somewhere to land.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/`);
  }
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
