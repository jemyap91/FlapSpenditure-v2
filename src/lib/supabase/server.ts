import { createServerClient as create } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/database.types";

/**
 * Server-side Supabase client for use in Server Components, Server Actions,
 * and Route Handlers. Reads the incoming request's cookies for the current
 * session and, where the runtime allows it, writes refreshed session
 * cookies back out.
 */
export async function createServerClient() {
  const cookieStore = await cookies();
  return create<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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
    },
  );
}
