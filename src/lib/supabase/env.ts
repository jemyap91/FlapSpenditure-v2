/**
 * Validates and exports the Supabase env vars once, rather than scattering
 * `!` non-null assertions (which lie to the type system, since a missing var
 * becomes `undefined` at runtime despite the `string` type) across each
 * client factory. Throws immediately on import if either var is missing, so
 * a misconfigured environment fails at boot rather than deep inside a
 * per-request client construction.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
export const supabaseAnonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
