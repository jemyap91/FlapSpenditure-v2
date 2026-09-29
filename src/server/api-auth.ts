import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase/env";
import type { ApiSession } from "@/lib/supabase/api-session";
import { signSupabaseJwt } from "@/lib/api-token";

/** Long enough for one MCP request; a new one is minted per request. */
const SESSION_SECONDS = 300;

export type ResolveResult =
  | { session: ApiSession }
  | { error: "invalid_token" | "not_configured" | "unavailable" };

/**
 * Turns a personal access token into a session for its user, or says why it
 * can't. `SUPABASE_JWT_SECRET` is read here, per call, rather than validated
 * at import like env.ts's variables: the rest of the app has no use for it,
 * and a deployment that never set it should keep working everywhere except
 * the MCP endpoint, which reports "not configured" instead.
 */
export async function resolveApiToken(token: string): Promise<ResolveResult> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return { error: "not_configured" };

  // Anon, no session: resolve_api_token is the one thing this caller may do
  // before it has a JWT, and the function is granted to anon for exactly
  // this (0028's comment).
  const anon = createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await anon.rpc("resolve_api_token", { p_token: token });
  if (error) return { error: "unavailable" };
  const row = data?.[0];
  if (!row) return { error: "invalid_token" };

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + SESSION_SECONDS;
  return {
    session: {
      accessToken: signSupabaseJwt({ sub: row.user_id, email: row.email, iat, exp }, secret),
      expiresAt: exp,
      user: { id: row.user_id, email: row.email },
    },
  };
}
