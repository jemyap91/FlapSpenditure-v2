// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const TXN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WALLET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CATEGORY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const { actions, stored } = vi.hoisted(() => ({
  actions: {
    createTransaction: vi.fn(),
    updateTransaction: vi.fn(),
    softDeleteTransaction: vi.fn(),
    restoreTransaction: vi.fn(),
    createRefund: vi.fn(),
  },
  stored: {
    row: null as Record<string, unknown> | null,
  },
}));

vi.mock("@/server/actions/transactions", () => actions);
vi.mock("@/server/actions/refunds", () => ({ createRefund: actions.createRefund }));
vi.mock("@/lib/today", () => ({ todayLocalDate: () => "2026-09-29" }));

// A read-only fake: every query against `transactions` resolves to the one
// stored row. The tools' reads only supply defaults and a response body --
// the writes they make go through the (mocked) server actions above.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "order", "limit", "gte", "lte", "or", "filter"]) builder[m] = () => builder;
      builder.then = (r: (v: unknown) => void) => r({ data: stored.row ? [stored.row] : [], error: null });
      builder.maybeSingle = async () => ({ data: stored.row });
      return builder;
    },
  }),
}));

import { callTool, toolList } from "./tools";

beforeEach(() => {
  Object.values(actions).forEach((fn) => fn.mockReset());
  stored.row = {
    id: TXN_ID,
    kind: "expense",
    amount_minor: -1250,
    currency_code: "SGD",
    occurred_on: "2026-09-28",
    category_id: CATEGORY_ID,
    note: "lunch",
    merchant: "Kopitiam",
    wallet_id: WALLET_ID,
    wallets: { name: "Main" },
    categories: { name: "Eating out" },
  };
});

describe("update_transaction", () => {
  it("fills every field the caller left out from the stored row", async () => {
    actions.updateTransaction.mockResolvedValue({ ok: true });
    const result = await callTool("update_transaction", { id: TXN_ID, amount: "14.00" });
    expect(actions.updateTransaction).toHaveBeenCalledWith({
      id: TXN_ID,
      wallet_id: undefined,
      amount: "14.00",
      occurred_on: "2026-09-28",
      category_id: CATEGORY_ID,
      note: "lunch",
      merchant: "Kopitiam",
    });
    expect(result.ok).toBe(true);
  });

  it("keeps the stored amount as a positive decimal in the currency's precision", async () => {
    actions.updateTransaction.mockResolvedValue({ ok: true });
    await callTool("update_transaction", { id: TXN_ID, note: "dinner" });
    expect(actions.updateTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: "12.50", note: "dinner" }));
  });

  it("treats an explicit null as clearing the field, not as leaving it", async () => {
    actions.updateTransaction.mockResolvedValue({ ok: true });
    await callTool("update_transaction", { id: TXN_ID, merchant: null, category_id: null });
    expect(actions.updateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ merchant: null, category_id: null, note: "lunch" }),
    );
  });

  it("passes the action's own error through", async () => {
    actions.updateTransaction.mockResolvedValue({ error: "SGD allows up to 2 decimal places." });
    expect(await callTool("update_transaction", { id: TXN_ID, amount: "1.005" })).toEqual({
      ok: false,
      error: "SGD allows up to 2 decimal places.",
    });
  });

  it("reports a row it can't see as not found without calling the action", async () => {
    stored.row = null;
    expect(await callTool("update_transaction", { id: TXN_ID, amount: "1" })).toEqual({
      ok: false,
      error: "Transaction not found",
    });
    expect(actions.updateTransaction).not.toHaveBeenCalled();
  });

  it("rejects a signed or symbol-carrying amount before reaching the action", async () => {
    for (const amount of ["-5", "$5", "5,00"]) {
      const result = await callTool("update_transaction", { id: TXN_ID, amount });
      expect(result.ok).toBe(false);
    }
    expect(actions.updateTransaction).not.toHaveBeenCalled();
  });
});

describe("create_transaction", () => {
  it("defaults to an expense dated today", async () => {
    actions.createTransaction.mockResolvedValue({ id: "new" });
    const result = await callTool("create_transaction", {
      wallet_id: WALLET_ID,
      amount: "3.20",
      category_id: CATEGORY_ID,
    });
    expect(actions.createTransaction).toHaveBeenCalledWith({
      wallet_id: WALLET_ID,
      kind: "expense",
      amount: "3.20",
      category_id: CATEGORY_ID,
      occurred_on: "2026-09-29",
      note: "",
      merchant: null,
    });
    expect(result).toEqual({ ok: true, data: { id: "new" } });
  });
});

describe("callTool", () => {
  it("names the bad field when arguments fail validation", async () => {
    expect(await callTool("delete_transaction", { id: "nope" })).toMatchObject({ ok: false, error: /^id: / });
  });

  it("refuses an unknown tool", async () => {
    expect(await callTool("drop_tables", {})).toEqual({ ok: false, error: "Unknown tool: drop_tables" });
  });
});

describe("toolList", () => {
  it("publishes a JSON Schema object for every tool", () => {
    const tools = toolList();
    expect(tools.map((t) => t.name)).toEqual([
      "list_wallets",
      "list_categories",
      "list_transactions",
      "create_transaction",
      "record_repayment",
      "update_transaction",
      "delete_transaction",
      "restore_transaction",
    ]);
    for (const t of tools) {
      expect(t.inputSchema).toMatchObject({ type: "object" });
      expect(t.inputSchema).not.toHaveProperty("$schema");
    }
    const update = tools.find((t) => t.name === "update_transaction")!;
    expect(update.inputSchema).toMatchObject({ required: ["id"] });
  });
});

describe("record_repayment", () => {
  it("defaults the wallet to the expense's and the date to today", async () => {
    actions.createRefund.mockResolvedValue({ id: "r1" });
    const result = await callTool("record_repayment", { expense_id: TXN_ID, amount: "5.00", note: "Alice" });
    expect(actions.createRefund).toHaveBeenCalledWith({
      refund_of: TXN_ID,
      wallet_id: WALLET_ID,
      amount: "5.00",
      occurred_on: "2026-09-29",
      note: "Alice",
      merchant: null,
    });
    expect(result).toEqual({ ok: true, data: { id: "r1" } });
  });

  it("passes an explicit wallet through and surfaces the action's refusal", async () => {
    actions.createRefund.mockResolvedValue({ error: "A repayment must be in the same currency as its expense." });
    const other = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const result = await callTool("record_repayment", { expense_id: TXN_ID, amount: "5.00", wallet_id: other });
    expect(actions.createRefund.mock.calls[0]![0].wallet_id).toBe(other);
    expect(result).toEqual({ ok: false, error: "A repayment must be in the same currency as its expense." });
  });

  it("says so when the expense can't be found", async () => {
    stored.row = null;
    const result = await callTool("record_repayment", { expense_id: TXN_ID, amount: "5.00" });
    expect(result).toEqual({ ok: false, error: "Expense not found" });
    expect(actions.createRefund).not.toHaveBeenCalled();
  });
});

describe("refunds through the existing tools", () => {
  it("edits a refund without inventing a category", async () => {
    stored.row = { ...stored.row!, kind: "refund", amount_minor: 500, category_id: null, categories: null, refund_of: CATEGORY_ID };
    actions.updateTransaction.mockResolvedValue({ ok: true });
    await callTool("update_transaction", { id: TXN_ID, amount: "6.00" });
    expect(actions.updateTransaction.mock.calls[0]![0].category_id).toBeNull();
  });

  it("lists refunds and presents the expense's category", async () => {
    const listed = await callTool("list_transactions", { kind: "refund" });
    expect(listed.ok).toBe(true);
    expect(toolList().find((t) => t.name === "record_repayment")).toBeDefined();
  });
});
