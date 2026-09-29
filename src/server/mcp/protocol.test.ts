// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { callTool, toolList } = vi.hoisted(() => ({
  callTool: vi.fn(),
  toolList: vi.fn(() => [{ name: "list_wallets", description: "d", inputSchema: { type: "object" } }]),
}));
vi.mock("@/server/mcp/tools", () => ({ callTool, toolList }));

import { handleMessage, SUPPORTED_PROTOCOL_VERSIONS } from "./protocol";

beforeEach(() => callTool.mockReset());

describe("handleMessage", () => {
  it("negotiates a protocol version the client asked for", async () => {
    const reply = await handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(reply).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } });
  });

  it("answers an unknown protocol version with its own latest", async () => {
    const reply = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(reply).toMatchObject({ result: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0] } });
  });

  it("does not reply to notifications", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled" })).toBeNull();
  });

  it("lists tools", async () => {
    const reply = await handleMessage({ jsonrpc: "2.0", id: "a", method: "tools/list" });
    expect(reply).toEqual({ jsonrpc: "2.0", id: "a", result: { tools: toolList() } });
  });

  it("returns a tool's data as text content", async () => {
    callTool.mockResolvedValue({ ok: true, data: { id: "t1" } });
    const reply = await handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "update_transaction", arguments: { id: "t1" } },
    });
    expect(callTool).toHaveBeenCalledWith("update_transaction", { id: "t1" });
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: JSON.stringify({ id: "t1" }, null, 2) }], isError: false },
    });
  });

  it("reports a tool's refusal as an isError result, not a protocol error", async () => {
    callTool.mockResolvedValue({ ok: false, error: "SGD allows up to 2 decimal places." });
    const reply = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "x" } });
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "SGD allows up to 2 decimal places." }], isError: true },
    });
  });

  it("rejects malformed messages and unknown methods", async () => {
    expect(await handleMessage({ id: 1, method: "tools/list" })).toMatchObject({ error: { code: -32600 } });
    expect(await handleMessage({ jsonrpc: "2.0", id: 1, method: "resources/list" })).toMatchObject({
      id: 1,
      error: { code: -32601 },
    });
    expect(await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).toMatchObject({
      error: { code: -32602 },
    });
  });
});
