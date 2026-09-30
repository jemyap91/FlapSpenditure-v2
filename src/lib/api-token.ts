import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Personal access tokens (supabase/migrations/0028_api_tokens.sql). The
 * `flap_` prefix makes a leaked token recognisable to secret scanners and to
 * a human reading a config file; the 32 random bytes after it are the
 * credential.
 */
export const TOKEN_PREFIX = "flap_";

export function generateApiToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * Must match resolve_api_token's `encode(sha256(convert_to(p_token,
 * 'UTF8')), 'hex')` exactly, or no token created here could ever resolve.
 * api-token.test.ts pins the pair against a known vector.
 */
export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** What the token list shows so one token can be told from another. */
export function displayPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX.length + 4);
}

/** Pulls the token out of an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

/**
 * Signs an HS256 JWT with the project's JWT secret, shaped like the access
 * token GoTrue itself issues on sign-in (`sub`, `role`, `aud`, `email`), so
 * PostgREST, RLS's auth.uid() and auth.jwt() ->> 'email', and GoTrue's own
 * /user endpoint all treat it exactly as a normal session.
 */
export function signSupabaseJwt(
  claims: { sub: string; email: string | null; exp: number; iat: number },
  secret: string,
): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    ...claims,
    email: claims.email ?? undefined,
    aud: "authenticated",
    role: "authenticated",
    is_anonymous: false,
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}
