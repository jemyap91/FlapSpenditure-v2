import { createBrowserClient as create } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";
import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase/env";

/**
 * Browser-side Supabase client. Used for auth (sign in/out, session
 * listeners) and realtime-style reads only — the browser never writes to
 * Supabase directly. All mutations go through Server Actions.
 */
export const createBrowserClient = () => create<Database>(supabaseUrl, supabaseAnonKey);
