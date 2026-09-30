import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A request that arrived with a personal access token instead of a browser
 * session (the MCP endpoint, src/app/api/mcp/route.ts). `accessToken` is a
 * short-lived Supabase JWT signed for `user` by src/server/api-auth.ts, so
 * PostgREST and RLS see exactly what they would see for that user signed in
 * through the app.
 */
export type ApiSession = {
  accessToken: string;
  expiresAt: number;
  user: { id: string; email: string | null };
};

const store = new AsyncLocalStorage<ApiSession>();

/**
 * Runs `fn` as the token's user: every `createClient()` call inside it
 * (src/lib/supabase/server.ts) authenticates with the minted JWT instead of
 * the request's cookies. This is what lets the MCP tools call the SAME
 * server actions the app's forms call -- every validation, archived-wallet
 * check and error message in src/server/actions/transactions.ts applies
 * unchanged -- rather than a parallel copy of that logic that could drift.
 */
export function runAsApiUser<T>(session: ApiSession, fn: () => Promise<T>): Promise<T> {
  return store.run(session, fn);
}

export function currentApiSession(): ApiSession | undefined {
  return store.getStore();
}
