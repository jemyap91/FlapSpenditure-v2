/**
 * Routes the session proxy (src/proxy.ts via updateSession) lets
 * unauthenticated requests through to. Extracted from middleware.ts so the
 * predicate is a pure function, testable without pulling in `next/server`.
 */
export const PUBLIC_PATHS = [
  "/login",
  "/signup",
  "/auth",
  // Bearer-token authenticated, not cookie-authenticated: redirecting an MCP
  // client to /login would only break it. The route checks its own token
  // (src/app/api/mcp/route.ts) and has no other way in.
  "/api/mcp",
];

/**
 * True when `path` is exactly one of PUBLIC_PATHS or a sub-path of one
 * (e.g. `/auth/callback`). Deliberately NOT a bare string-prefix check:
 * `path.startsWith(p)` alone would also match `/login-help`, `/signups`,
 * `/authorize` — making any future route that happens to start with a
 * public path's characters public by accident.
 */
export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}
