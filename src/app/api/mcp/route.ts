import type { NextRequest } from "next/server";
import { bearerToken } from "@/lib/api-token";
import { runAsApiUser } from "@/lib/supabase/api-session";
import { resolveApiToken } from "@/server/api-auth";
import { handleMessage, type JsonRpcResponse } from "@/server/mcp/protocol";

/**
 * POST /api/mcp -- the ledger's MCP endpoint (src/server/mcp/protocol.ts).
 *
 * Authenticated by a personal access token (`Authorization: Bearer
 * flap_...`) created on /api-access, never by cookies: this route is listed
 * in PUBLIC_PATHS so the session proxy doesn't redirect it to /login, which
 * makes the token check below the only gate. Each request mints a fresh
 * five-minute JWT for the token's user and runs every tool call as them.
 */
export async function POST(request: NextRequest) {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return unauthorized("Missing bearer token");

  const resolved = await resolveApiToken(token);
  if ("error" in resolved) {
    if (resolved.error === "invalid_token") return unauthorized("Invalid or revoked token");
    if (resolved.error === "not_configured") {
      return Response.json({ error: "The MCP endpoint is not configured on this server" }, { status: 503 });
    }
    return Response.json({ error: "Could not check that token. Please try again." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  const messages = Array.isArray(body) ? body : [body];
  const replies = await runAsApiUser(resolved.session, async () => {
    const out: JsonRpcResponse[] = [];
    // Sequential, not Promise.all: a batch that edits then reads a row must
    // see its own edit.
    for (const message of messages) {
      const reply = await handleMessage(message);
      if (reply) out.push(reply);
    }
    return out;
  });

  // Only notifications (e.g. notifications/initialized): 202, no body.
  if (replies.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}

/** No server-initiated stream: this server never sends unprompted messages. */
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

function unauthorized(message: string) {
  return Response.json(
    { error: message },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="flapspenditure"' } },
  );
}
