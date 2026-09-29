import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/lib/database.types";
import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase/env";
import { currentApiSession, type ApiSession } from "@/lib/supabase/api-session";

/**
 * Server-side Supabase client for use in Server Components, Server Actions,
 * and Route Handlers. Reads the incoming request's cookies for the current
 * session and, where the runtime allows it, writes refreshed session
 * cookies back out.
 *
 * Named `createClient` rather than `createServerClient` (as originally
 * specified) to avoid colliding with `@supabase/ssr`'s own `createServerClient`
 * export, which src/lib/supabase/middleware.ts imports unaliased. Both names
 * resolving in the same directory was a latent footgun for every task that
 * imports this module.
 */
export async function createClient() {
  const apiSession = currentApiSession();
  if (apiSession) return createApiClient(apiSession);

  const cookieStore = await cookies();
  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Proxy (src/proxy.ts) refreshes the session instead, so this is safe to ignore.
        }
      },
    },
  });
}

/**
 * The client for a request authenticated by a personal access token (see
 * runAsApiUser in src/lib/supabase/api-session.ts). The session is handed to
 * supabase-js through a read-only storage adapter rather than setSession(),
 * which would spend a GoTrue round-trip validating a token the caller is
 * about to validate again with `auth.getUser()` anyway. Nothing is persisted
 * or refreshed: the minted JWT outlives the request it was minted for.
 */
function createApiClient(session: ApiSession) {
  const stored = JSON.stringify({
    access_token: session.accessToken,
    token_type: "bearer",
    expires_at: session.expiresAt,
    expires_in: session.expiresAt - Math.floor(Date.now() / 1000),
    // Never sent: autoRefreshToken is off and the JWT outlives the request.
    refresh_token: "",
    user: { id: session.user.id, email: session.user.email, aud: "authenticated", role: "authenticated" },
  });
  return createSupabaseClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "api-token-session",
      storage: {
        getItem: () => stored,
        setItem: () => {},
        removeItem: () => {},
      },
    },
  });
}
