/**
 * Validates and exports the Supabase env vars once, rather than scattering
 * `!` non-null assertions (which lie to the type system, since a missing var
 * becomes `undefined` at runtime despite the `string` type) across each
 * client factory. Throws immediately on import if either var is missing, so
 * a misconfigured environment fails at boot rather than deep inside a
 * per-request client construction.
 */
/**
 * Takes the VALUE, not just the name, because the caller must reference
 * `process.env.NEXT_PUBLIC_...` statically for it to exist in the browser
 * at all.
 *
 * This function used to do the lookup itself (`process.env[name]`), which
 * silently produced a server-only module: Next replaces `NEXT_PUBLIC_*`
 * reads with literals at build time, and per
 * node_modules/next/dist/docs/01-app/02-guides/environment-variables.md
 * ("dynamic lookups will _not_ be inlined") a computed key is not
 * replaceable, so the browser bundle received a bare `process.env[name]`
 * against an empty object and threw "Missing required environment
 * variable" on load — with the vars correctly set the whole time.
 *
 * It stayed hidden because nothing in a Client Component imported
 * `client.ts` (the browser factory it feeds) until Google sign-in did. The
 * `name` parameter survives only to keep that message specific.
 */
function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const supabaseUrl = requireEnv(
  "NEXT_PUBLIC_SUPABASE_URL",
  process.env.NEXT_PUBLIC_SUPABASE_URL,
);
export const supabaseAnonKey = requireEnv(
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);
