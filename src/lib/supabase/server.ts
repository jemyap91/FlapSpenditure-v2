import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/database.types";
import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase/env";

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
