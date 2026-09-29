import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { ApiTokens, type ApiTokenRow } from "./ApiTokens";

/**
 * /api-access -- personal access tokens for the MCP endpoint
 * (src/app/api/mcp/route.ts), so Claude can read and update this ledger.
 *
 * `api_tokens_owner` RLS scopes the read to the caller's own tokens; a
 * household member never sees another member's.
 */
export default async function ApiAccessPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("api_tokens")
    .select("id, name, token_prefix, created_at, last_used_at, revoked_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error("Failed to load tokens");

  // The endpoint lives on this same deployment. Derived from the request
  // rather than configured, so a preview deployment shows its own URL.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const endpoint = `${proto}://${host}/api/mcp`;

  const rows: ApiTokenRow[] = data ?? [];
  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-1 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Connect Claude
      </h1>
      <p className="mb-6 text-sm" style={{ color: "var(--ink-2)" }}>
        Create a token to let Claude look up, add, and update your transactions through MCP. A token acts as you:
        it can see and change everything you can, so keep it private and revoke it when you stop using it.
      </p>
      <ApiTokens tokens={rows} endpoint={endpoint} />
    </div>
  );
}
