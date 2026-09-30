import "server-only";
import { callTool, toolList } from "@/server/mcp/tools";

/**
 * A stateless MCP server over Streamable HTTP
 * (https://modelcontextprotocol.io/specification/2025-06-18/basic/transports):
 * every request is one JSON-RPC POST answered with one JSON body, never an
 * SSE stream, and no session id is issued -- the bearer token is re-checked
 * on every request, so there is no server-side state to keep.
 *
 * Hand-rolled rather than built on @modelcontextprotocol/sdk: tools only,
 * no resources, prompts, sampling or notifications to the client, which is
 * four methods -- less code than adapting the SDK's Node-stream transport to
 * a Route Handler's Web Request/Response.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, unknown> };
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

const INSTRUCTIONS =
  "Tools for the user's expense ledger. Amounts are positive decimal strings in the wallet's currency; " +
  "whether money went out or came in is the transaction's kind. To change a transaction, find its id " +
  "with list_transactions first, then call update_transaction with only the fields that change. " +
  "Before recording a new expense or income, ask the user for the merchant if they didn't say who it was.";

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (value as { method?: unknown }).method === "string"
  );
}

const error = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** Handles one message. Returns null for a notification, which gets no reply. */
export async function handleMessage(message: unknown): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) return error(null, -32600, "Invalid Request");
  const isNotification = message.id === undefined;
  const id = message.id ?? null;
  const params = message.params ?? {};

  switch (message.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "flapspenditure", version: "1.0.0" },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: toolList() } };
    case "tools/call": {
      if (typeof params.name !== "string") return error(id, -32602, "Missing tool name");
      const outcome = await callTool(params.name, params.arguments);
      // A tool that ran and refused (bad amount, archived wallet...) is a
      // tool RESULT with isError, not a JSON-RPC error: the spec reserves
      // protocol errors for malformed calls, and a result is what the model
      // actually gets to read and correct itself from.
      const text = outcome.ok ? JSON.stringify(outcome.data, null, 2) : outcome.error;
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }], isError: !outcome.ok },
      };
    }
    default:
      if (isNotification) return null;
      return error(id, -32601, `Method not found: ${message.method}`);
  }
}
