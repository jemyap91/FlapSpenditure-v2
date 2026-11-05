// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const TXN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WALLET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EXPENSE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CATEGORY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_WALLET_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const { actions, stored, tracker, bonus, calls } = vi.hoisted(() => ({
  actions: {
    createTransaction: vi.fn(),
    updateTransaction: vi.fn(),
    softDeleteTransaction: vi.fn(),
    restoreTransaction: vi.fn(),
    createRefund: vi.fn(),
    createTransfer: vi.fn(),
    updateTransfer: vi.fn(),
  },
  tracker: { loadCardTracker: vi.fn(), warningsFor: vi.fn() },
  bonus: { setWalletBonus: vi.fn() },
  // Every builder method the fake sees, as [method, ...args].
  calls: [] as unknown[][],
  stored: {
    // When set, createClient rejects, as it does when the session is gone.
    clientDown: false,
    row: null as Record<string, unknown> | null,
    // What an array query (no maybeSingle) returns, when a test needs more
    // than the one stored row -- a transfer's two legs.
    list: null as Record<string, unknown>[] | null,
  },
}));

vi.mock("@/server/actions/transactions", () => actions);
vi.mock("@/server/actions/refunds", () => ({ createRefund: actions.createRefund }));
vi.mock("@/server/card-tracker", () => tracker);
vi.mock("@/server/actions/wallet-bonus", () => bonus);
vi.mock("@/lib/today", () => ({ todayLocalDate: () => "2026-09-29" }));

// A read-only fake: every query against `transactions` resolves to the one
// stored row. The tools' reads only supply defaults and a response body --
// the writes they make go through the (mocked) server actions above.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (stored.clientDown) throw new Error("no session");
    return {
      from: () => {
        const builder: Record<string, unknown> = {};
        for (const m of ["select", "eq", "is", "order", "limit", "gte", "lte", "or", "filter"]) {
          builder[m] = (...a: unknown[]) => {
            calls.push([m, ...a]);
            return builder;
          };
        }
        builder.then = (r: (v: unknown) => void) =>
          r({ data: stored.list ?? (stored.row ? [stored.row] : []), error: null });
        builder.maybeSingle = async () => ({ data: stored.row });
        return builder;
      },
    };
  },
}));

import { callTool, toolList } from "./tools";

beforeEach(() => {
  Object.values(actions).forEach((fn) => fn.mockReset());
  Object.values(tracker).forEach((fn) => fn.mockReset());
  bonus.setWalletBonus.mockReset();
  tracker.warningsFor.mockResolvedValue({ channel: null, warnings: [] });
  calls.length = 0;
  stored.clientDown = false;
  stored.list = null;
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
      merchant: null,
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
    expect(result).toEqual({ ok: true, data: { id: "new", channel: null, warnings: [] } });
  });

  it("passes the merchant the user gave through to the action", async () => {
    actions.createTransaction.mockResolvedValue({ id: "new" });
    await callTool("create_transaction", {
      wallet_id: WALLET_ID,
      amount: "3.20",
      category_id: CATEGORY_ID,
      merchant: "Kopitiam",
    });
    expect(actions.createTransaction.mock.calls[0]![0].merchant).toBe("Kopitiam");
  });

  it("refuses a call that never considered the merchant, so the caller has to ask", async () => {
    const result = await callTool("create_transaction", {
      wallet_id: WALLET_ID,
      amount: "3.20",
      category_id: CATEGORY_ID,
    });
    expect(result).toMatchObject({ ok: false, error: /^merchant: / });
    expect(actions.createTransaction).not.toHaveBeenCalled();
  });
});

describe("create_transaction channel and warnings", () => {
  const base = { wallet_id: WALLET_ID, amount: "3.20", category_id: CATEGORY_ID, merchant: "Kopitiam" };

  it("passes a channel through, and leaves it undefined when omitted", async () => {
    actions.createTransaction.mockResolvedValue({ id: "new" });
    await callTool("create_transaction", { ...base, channel: "online" });
    expect(actions.createTransaction.mock.calls[0]![0].channel).toBe("online");
    await callTool("create_transaction", base);
    expect(actions.createTransaction.mock.calls[1]![0].channel).toBeUndefined();
    await callTool("create_transaction", { ...base, channel: null });
    expect(actions.createTransaction.mock.calls[2]![0].channel).toBeNull();
  });

  it("returns the saved channel and warnings as ok", async () => {
    actions.createTransaction.mockResolvedValue({ id: "new" });
    tracker.warningsFor.mockResolvedValue({ channel: "in_store", warnings: ["Not Online: no bonus on this card."] });
    const result = await callTool("create_transaction", base);
    expect(tracker.warningsFor).toHaveBeenCalledWith(expect.anything(), "new");
    expect(result).toEqual({
      ok: true,
      data: { id: "new", channel: "in_store", warnings: ["Not Online: no bonus on this card."] },
    });
  });

  it("still reports success when the warnings cannot be checked", async () => {
    actions.createTransaction.mockResolvedValue({ id: "new" });
    tracker.warningsFor.mockRejectedValue(new Error("Failed to load warnings"));
    stored.row = { channel: "bill" };
    const result = await callTool("create_transaction", base);
    expect(result).toEqual({
      ok: true,
      data: { id: "new", channel: "bill", warnings: ["The expense was saved, but its warnings couldn't be checked."] },
    });
  });

  it("still reports success when the client cannot even be created after the save", async () => {
    actions.createTransaction.mockImplementation(async () => {
      // The save lands, then the session goes away.
      stored.clientDown = true;
      return { id: "new" };
    });
    const result = await callTool("create_transaction", base);
    expect(result).toEqual({
      ok: true,
      data: { id: "new", channel: null, warnings: ["The expense was saved, but its warnings couldn't be checked."] },
    });
  });

  it("does not look for warnings when the save is refused", async () => {
    actions.createTransaction.mockResolvedValue({ error: "Choose a category" });
    expect(await callTool("create_transaction", base)).toEqual({ ok: false, error: "Choose a category" });
    expect(tracker.warningsFor).not.toHaveBeenCalled();
  });
});

describe("update_transaction channel and warnings", () => {
  it("passes channel through, leaving it undefined to keep and null to clear", async () => {
    actions.updateTransaction.mockResolvedValue({ ok: true });
    await callTool("update_transaction", { id: TXN_ID, channel: "bill" });
    await callTool("update_transaction", { id: TXN_ID, note: "x" });
    await callTool("update_transaction", { id: TXN_ID, channel: null });
    expect(actions.updateTransaction.mock.calls.map((c) => c[0].channel)).toEqual(["bill", undefined, null]);
  });

  it("carries the warnings from after the save", async () => {
    actions.updateTransaction.mockResolvedValue({ ok: true });
    tracker.warningsFor.mockResolvedValue({ channel: "bill", warnings: ["w1"] });
    const result = await callTool("update_transaction", { id: TXN_ID, wallet_id: OTHER_WALLET_ID });
    expect(tracker.warningsFor).toHaveBeenCalledWith(expect.anything(), TXN_ID);
    expect(result).toMatchObject({ ok: true, data: { id: TXN_ID, warnings: ["w1"] } });
  });

  it("still reports success when the warnings cannot be checked", async () => {
    actions.updateTransaction.mockResolvedValue({ ok: true });
    tracker.warningsFor.mockRejectedValue(new Error("Failed to load warnings"));
    stored.row = { ...stored.row!, channel: "bill" };
    const result = await callTool("update_transaction", { id: TXN_ID, note: "y" });
    expect(result).toMatchObject({
      ok: true,
      data: { id: TXN_ID, channel: "bill", warnings: ["The expense was saved, but its warnings couldn't be checked."] },
    });
  });
});

describe("list_transactions channel", () => {
  it("returns channel and mismatch", async () => {
    stored.row = { ...stored.row!, channel: "in_store", channel_mismatch: true };
    const rows = ((await callTool("list_transactions", {})) as { data: Record<string, unknown>[] }).data;
    expect(rows[0]).toMatchObject({ channel: "in_store", mismatch: true });
    stored.row = { ...stored.row!, channel: null, channel_mismatch: null };
    const again = ((await callTool("list_transactions", {})) as { data: Record<string, unknown>[] }).data;
    expect(again[0]).toMatchObject({ channel: null, mismatch: false });
  });

  it("applies the channel and mismatch filters, and neither by default", async () => {
    await callTool("list_transactions", {});
    expect(calls.some(([m, col]) => m === "eq" && col === "channel")).toBe(false);
    expect(calls.some(([m]) => m === "filter")).toBe(false);
    await callTool("list_transactions", { channel: "bill", mismatch: true });
    expect(calls).toContainEqual(["eq", "channel", "bill"]);
    expect(calls).toContainEqual(["filter", "channel_mismatch", "eq", true]);
  });
});

describe("list_wallets bonus terms", () => {
  it("returns the channel, cycle day and max as a decimal string, or null", async () => {
    stored.list = [
      { id: WALLET_ID, name: "Card", kind: "card", currency_code: "SGD", bonus_channel: "online", cycle_start_day: 5, bonus_cap_minor: 80000 },
      { id: OTHER_WALLET_ID, name: "Cash", kind: "cash", currency_code: "SGD", bonus_channel: null, cycle_start_day: null, bonus_cap_minor: null },
    ];
    const rows = ((await callTool("list_wallets", {})) as { data: Record<string, unknown>[] }).data;
    expect(rows[0]).toMatchObject({ bonus_channel: "online", cycle_start_day: 5, max: "800.00" });
    expect(rows[1]).toMatchObject({ bonus_channel: null, cycle_start_day: null, max: null });
  });
});

describe("get_card_tracker", () => {
  const row = {
    walletId: WALLET_ID,
    walletName: "Card",
    currency: "SGD",
    bonusChannel: "online",
    capMinor: 80000,
    from: "2026-09-05",
    to: "2026-10-04",
    spentMinor: 12345,
    remainingMinor: 67655,
    pace: "under",
    mismatchCount: 2,
  };

  it("defaults the date to today and returns decimal strings", async () => {
    tracker.loadCardTracker.mockResolvedValue([row]);
    const result = await callTool("get_card_tracker", {});
    expect(tracker.loadCardTracker).toHaveBeenCalledWith(expect.anything(), { on: "2026-09-29", today: "2026-09-29" });
    expect(result).toEqual({
      ok: true,
      data: [
        {
          wallet: { id: WALLET_ID, name: "Card" },
          currency: "SGD",
          bonus_channel: "online",
          from: "2026-09-05",
          to: "2026-10-04",
          spent: "123.45",
          max: "800.00",
          remaining: "676.55",
          pace: "under",
          mismatch_count: 2,
        },
      ],
    });
  });

  it("passes a past date through, still measuring pace against today", async () => {
    tracker.loadCardTracker.mockResolvedValue([]);
    await callTool("get_card_tracker", { on: "2026-08-10" });
    expect(tracker.loadCardTracker).toHaveBeenCalledWith(expect.anything(), { on: "2026-08-10", today: "2026-09-29" });
  });

  it("rejects a date that is not on the calendar", async () => {
    expect(await callTool("get_card_tracker", { on: "2026-02-30" })).toMatchObject({ ok: false, error: /^on: / });
    expect(tracker.loadCardTracker).not.toHaveBeenCalled();
  });

  it("reports a failed read as a tool error, not empty figures", async () => {
    tracker.loadCardTracker.mockRejectedValue(new Error("Failed to load card tracker"));
    expect(await callTool("get_card_tracker", {})).toEqual({ ok: false, error: "Could not load card tracker" });
  });
});

describe("update_wallet_bonus", () => {
  beforeEach(() => {
    stored.row = { currency_code: "SGD", bonus_channel: "online", cycle_start_day: 5, bonus_cap_minor: 80000 };
    bonus.setWalletBonus.mockResolvedValue({ ok: true });
  });

  it("keeps omitted fields at their current values", async () => {
    const result = await callTool("update_wallet_bonus", { wallet_id: WALLET_ID, cycle_start_day: 12 });
    expect(bonus.setWalletBonus).toHaveBeenCalledWith({
      wallet_id: WALLET_ID,
      bonus_channel: "online",
      cycle_start_day: 12,
      max: "800.00",
    });
    expect(result.ok).toBe(true);
  });

  it("clears a field passed as null", async () => {
    await callTool("update_wallet_bonus", { wallet_id: WALLET_ID, max: null });
    expect(bonus.setWalletBonus).toHaveBeenCalledWith({
      wallet_id: WALLET_ID,
      bonus_channel: "online",
      cycle_start_day: 5,
      max: null,
    });
  });

  it("reports a wallet it can't see without saving", async () => {
    stored.row = null;
    expect(await callTool("update_wallet_bonus", { wallet_id: WALLET_ID, max: "1" })).toEqual({
      ok: false,
      error: "Wallet not found",
    });
    expect(bonus.setWalletBonus).not.toHaveBeenCalled();
  });

  it("passes the action's refusal through", async () => {
    bonus.setWalletBonus.mockResolvedValue({ error: "Set a channel and cycle start day to use a max" });
    expect(await callTool("update_wallet_bonus", { wallet_id: WALLET_ID, bonus_channel: null })).toEqual({
      ok: false,
      error: "Set a channel and cycle start day to use a max",
    });
  });

  it("rejects an unknown channel or a cycle day outside 1-31", async () => {
    expect((await callTool("update_wallet_bonus", { wallet_id: WALLET_ID, bonus_channel: "cheque" })).ok).toBe(false);
    expect((await callTool("update_wallet_bonus", { wallet_id: WALLET_ID, cycle_start_day: 32 })).ok).toBe(false);
    expect(bonus.setWalletBonus).not.toHaveBeenCalled();
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
  it("tells the client that saving tools can return warnings to relay", () => {
    for (const name of ["create_transaction", "update_transaction"]) {
      const tool = toolList().find((t) => t.name === name)!;
      expect(tool.description).toMatch(/warnings/);
    }
  });

  it("publishes a JSON Schema object for every tool", () => {
    const tools = toolList();
    expect(tools.map((t) => t.name)).toEqual([
      "list_wallets",
      "list_categories",
      "list_transactions",
      "create_transaction",
      "record_repayment",
      "record_transfer",
      "update_transaction",
      "update_transfer",
      "delete_transaction",
      "get_card_tracker",
      "update_wallet_bonus",
      "restore_transaction",
    ]);
    for (const t of tools) {
      expect(t.inputSchema).toMatchObject({ type: "object" });
      expect(t.inputSchema).not.toHaveProperty("$schema");
    }
    const update = tools.find((t) => t.name === "update_transaction")!;
    expect(update.inputSchema).toMatchObject({ required: ["id"] });
  });

  it("requires a merchant on create and tells the caller to ask for it", () => {
    const create = toolList().find((t) => t.name === "create_transaction")!;
    const schema = create.inputSchema as { required: string[]; properties: Record<string, { description?: string }> };
    expect(schema.required).toContain("merchant");
    expect(schema.properties.merchant!.description).toMatch(/ask the user/i);
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
    stored.row = { ...stored.row!, kind: "refund", amount_minor: 500, category_id: null, categories: null, refund_of: EXPENSE_ID };
    actions.updateTransaction.mockResolvedValue({ ok: true });
    await callTool("update_transaction", { id: TXN_ID, amount: "6.00" });
    expect(actions.updateTransaction.mock.calls[0]![0].category_id).toBeNull();
  });

  it("lists refunds under the expense's category and says which expense they repay", async () => {
    stored.row = {
      ...stored.row!,
      kind: "refund",
      amount_minor: 500,
      category_id: null,
      categories: null,
      refund_of: EXPENSE_ID,
      repaid_expense: { category_id: CATEGORY_ID, categories: { name: "Eating out" } },
    };
    const listed = await callTool("list_transactions", { kind: "refund" });
    expect(listed.ok).toBe(true);
    const rows = (listed as { data: Record<string, unknown>[] }).data;
    expect(rows[0]!.category).toEqual({ id: CATEGORY_ID, name: "Eating out" });
    expect(rows[0]!.repays).toBe(EXPENSE_ID);
    expect(toolList().find((t) => t.name === "record_repayment")).toBeDefined();
  });

  it("still presents an expense's own category and no repays", async () => {
    const listed = await callTool("list_transactions", {});
    const rows = (listed as { data: Record<string, unknown>[] }).data;
    expect(rows[0]!.category).toEqual({ id: CATEGORY_ID, name: "Eating out" });
    expect(rows[0]!.repays).toBeNull();
  });
});

const TRANSFER_ID = "99999999-9999-4999-8999-999999999999";

/** A same-currency transfer: 50.00 out of Main, 50.00 into Savings. */
function transferLegs(over: { inMinor?: number; inCurrency?: string } = {}) {
  stored.row = { id: TXN_ID, kind: "transfer", transfer_id: TRANSFER_ID };
  stored.list = [
    { wallet_id: WALLET_ID, amount_minor: -5000, currency_code: "SGD", occurred_on: "2026-09-20", note: "top up", merchant: null },
    {
      wallet_id: OTHER_WALLET_ID,
      amount_minor: over.inMinor ?? 5000,
      currency_code: over.inCurrency ?? "SGD",
      occurred_on: "2026-09-20",
      note: "top up",
      merchant: null,
    },
  ];
}

describe("record_transfer", () => {
  it("moves money between two wallets, dated today by default", async () => {
    actions.createTransfer.mockResolvedValue({ transferId: TRANSFER_ID });
    const result = await callTool("record_transfer", {
      from_wallet_id: WALLET_ID,
      to_wallet_id: OTHER_WALLET_ID,
      amount: "200.00",
      note: "savings",
    });
    expect(actions.createTransfer).toHaveBeenCalledWith({
      from_wallet_id: WALLET_ID,
      to_wallet_id: OTHER_WALLET_ID,
      amount: "200.00",
      amount_in: undefined,
      occurred_on: "2026-09-29",
      note: "savings",
    });
    expect(result).toEqual({ ok: true, data: { transferId: TRANSFER_ID } });
  });

  it("passes a received amount through for a cross-currency transfer", async () => {
    actions.createTransfer.mockResolvedValue({ transferId: TRANSFER_ID });
    await callTool("record_transfer", {
      from_wallet_id: WALLET_ID,
      to_wallet_id: OTHER_WALLET_ID,
      amount: "100.00",
      amount_in: "73.50",
      occurred_on: "2026-09-25",
    });
    expect(actions.createTransfer.mock.calls[0]![0]).toMatchObject({ amount_in: "73.50", occurred_on: "2026-09-25", note: "" });
  });

  it("surfaces the action's refusal", async () => {
    actions.createTransfer.mockResolvedValue({ error: "cannot transfer to the same wallet" });
    const result = await callTool("record_transfer", {
      from_wallet_id: WALLET_ID,
      to_wallet_id: WALLET_ID,
      amount: "1.00",
    });
    expect(result).toEqual({ ok: false, error: "cannot transfer to the same wallet" });
  });
});

describe("update_transfer", () => {
  it("keeps a same-currency transfer balanced when only the amount changes", async () => {
    transferLegs();
    actions.updateTransfer.mockResolvedValue({ ok: true });
    const result = await callTool("update_transfer", { id: TXN_ID, amount: "60.00" });
    expect(actions.updateTransfer).toHaveBeenCalledWith({
      transfer_id: TRANSFER_ID,
      amount_out: "60.00",
      amount_in: "60.00",
      occurred_on: "2026-09-20",
      note: "top up",
      merchant: null,
    });
    expect(result).toEqual({ ok: true, data: { id: TXN_ID, transfer_id: TRANSFER_ID } });
  });

  it("keeps a cross-currency transfer's received amount unless told otherwise", async () => {
    transferLegs({ inMinor: 3675, inCurrency: "USD" });
    actions.updateTransfer.mockResolvedValue({ ok: true });
    await callTool("update_transfer", { id: TXN_ID, amount: "60.00", occurred_on: "2026-09-21" });
    expect(actions.updateTransfer.mock.calls[0]![0]).toMatchObject({
      amount_out: "60.00",
      amount_in: "36.75",
      occurred_on: "2026-09-21",
    });
  });

  it("changes only the note when that is all that is passed", async () => {
    transferLegs();
    actions.updateTransfer.mockResolvedValue({ ok: true });
    await callTool("update_transfer", { id: TXN_ID, note: null });
    expect(actions.updateTransfer.mock.calls[0]![0]).toMatchObject({ amount_out: "50.00", amount_in: "50.00", note: null });
  });

  it("points a non-transfer at update_transaction", async () => {
    const result = await callTool("update_transfer", { id: TXN_ID, amount: "1.00" });
    expect(result).toEqual({ ok: false, error: "That isn't a transfer. Use update_transaction for it." });
    expect(actions.updateTransfer).not.toHaveBeenCalled();
  });

  it("says so when the transaction isn't found", async () => {
    stored.row = null;
    expect(await callTool("update_transfer", { id: TXN_ID })).toEqual({ ok: false, error: "Transfer not found" });
  });
});
