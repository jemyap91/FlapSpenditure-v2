import "server-only";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { formatAmountInput, minorUnitFor } from "@/lib/money";
import { todayLocalDate } from "@/lib/today";
import { ilikePattern, SEARCH_MAX_LENGTH } from "@/lib/transaction-filters";
import { createRefund } from "@/server/actions/refunds";
import {
  createTransaction,
  restoreTransaction,
  softDeleteTransaction,
  updateTransaction,
} from "@/server/actions/transactions";

/**
 * The ledger as MCP tools. Every tool runs inside runAsApiUser (see
 * src/app/api/mcp/route.ts), so `createClient()` here and inside the server
 * actions is the token owner's own RLS-scoped client: a tool can see and
 * change exactly what that person can in the app, nothing more.
 *
 * Writes go through the app's own server actions rather than their own
 * queries, so an edit made by Claude is held to every rule an edit made in
 * the form is -- currency precision, archived wallets and categories,
 * category kind, the wallet-move checks -- and fails with the same message.
 */

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

type Tool = {
  description: string;
  input: z.ZodType;
  run: (args: never) => Promise<ToolResult>;
};

const uuid = z.uuid();
const isoDate = z.iso.date("Use a YYYY-MM-DD date");
const amount = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "Use a positive decimal amount like \"12.50\", without a currency symbol or sign")
  .describe('Positive amount as a decimal string, e.g. "12.50". The sign comes from the kind.');

const listTransactionsInput = z.object({
  wallet_id: uuid.optional(),
  category_id: uuid.optional(),
  kind: z.enum(["expense", "income", "transfer", "refund"]).optional(),
  from: isoDate.optional().describe("Inclusive start date, YYYY-MM-DD"),
  to: isoDate.optional().describe("Inclusive end date, YYYY-MM-DD"),
  search: z.string().trim().min(1).max(SEARCH_MAX_LENGTH).optional().describe("Matches merchant or note"),
  limit: z.number().int().min(1).max(200).default(50),
});

const createInput = z.object({
  wallet_id: uuid,
  kind: z.enum(["expense", "income"]).default("expense"),
  amount,
  category_id: uuid.describe("A category of the same kind, from list_categories"),
  occurred_on: isoDate.optional().describe("Defaults to today"),
  // Required, unlike update's: a merchant is known at the moment of recording
  // or not at all, so the caller has to decide — by asking — rather than
  // silently leaving it out. The refusal says so, since Claude reads it.
  merchant: z
    .string({
      error: (issue) =>
        issue.input === undefined
          ? "Ask the user who the merchant was, then pass it, or null if they say there isn't one"
          : undefined,
    })
    .max(120)
    .nullable()
    .describe(
      "Who the money went to or came from (a shop, restaurant, person). If the user hasn't said, ask the user before calling; pass null only if they say there isn't one.",
    ),
  note: z.string().max(280).nullable().optional(),
});

const updateInput = z.object({
  id: uuid,
  amount: amount.optional(),
  occurred_on: isoDate.optional(),
  category_id: uuid.nullable().optional().describe("null clears the category"),
  merchant: z.string().max(120).nullable().optional().describe("null clears it"),
  note: z.string().max(280).nullable().optional().describe("null clears it"),
  wallet_id: uuid.optional().describe("Moves the transaction to another wallet with the same currency"),
});

const repaymentInput = z.object({
  expense_id: uuid.describe("The expense being paid back, from list_transactions"),
  amount,
  wallet_id: uuid.optional().describe("Where the money landed. Defaults to the expense's wallet; must be the same currency"),
  occurred_on: isoDate.optional().describe("When it was paid back. Defaults to today"),
  note: z.string().max(280).nullable().optional().describe("Who paid, e.g. \"Alice\""),
});

const idInput = z.object({ id: uuid });

/** One transaction as tools return it: a positive amount plus its kind. */
function presentTransaction(row: {
  id: string;
  kind: string;
  amount_minor: number;
  currency_code: string;
  occurred_on: string;
  merchant: string | null;
  note: string | null;
  wallet_id: string;
  category_id: string | null;
  refund_of?: string | null;
  repaid_expense?: { category_id: string | null; categories: { name: string } | null } | null;
  wallets: { name: string } | null;
  categories: { name: string } | null;
}) {
  const source = row.kind === "refund" ? row.repaid_expense : row;
  return {
    id: row.id,
    date: row.occurred_on,
    kind: row.kind,
    amount: formatAmountInput(Math.abs(row.amount_minor), minorUnitFor(row.currency_code)),
    currency: row.currency_code,
    merchant: row.merchant,
    note: row.note,
    wallet: { id: row.wallet_id, name: row.wallets?.name ?? null },
    // A refund counts under its expense's category (spec §3.1); show that.
    category: source?.category_id ? { id: source.category_id, name: source.categories?.name ?? null } : null,
    repays: row.refund_of ?? null,
  };
}

type PresentRow = Parameters<typeof presentTransaction>[0];

const TRANSACTION_COLUMNS =
  "id, kind, amount_minor, currency_code, occurred_on, merchant, note, wallet_id, category_id, refund_of, wallets!transactions_wallet_id_fkey(name), categories!transactions_category_id_fkey(name), repaid_expense(category_id, categories!transactions_category_id_fkey(name))";

function fromAction(result: { error: string } | object, data: unknown): ToolResult {
  return "error" in result ? { ok: false, error: result.error } : { ok: true, data };
}

export const TOOLS: Record<string, Tool> = {
  list_wallets: {
    description:
      "List the wallets (accounts) you can record transactions in, with their ids and currencies. Archived wallets are left out.",
    input: z.object({}),
    run: async () => {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from("wallets")
        .select("id, name, kind, currency_code")
        .is("archived_at", null)
        .order("name");
      if (error) return { ok: false, error: "Could not load wallets" };
      return { ok: true, data: data.map((w) => ({ id: w.id, name: w.name, kind: w.kind, currency: w.currency_code })) };
    },
  },

  list_categories: {
    description:
      "List active categories with their ids. An expense needs an expense category and an income an income category.",
    input: z.object({ kind: z.enum(["expense", "income"]).optional() }),
    run: async (args: { kind?: "expense" | "income" }) => {
      const supabase = await createClient();
      let query = supabase
        .from("categories")
        .select("id, name, kind, space_id")
        .is("archived_at", null)
        .order("kind")
        .order("sort_order");
      if (args.kind) query = query.eq("kind", args.kind);
      const { data, error } = await query;
      if (error) return { ok: false, error: "Could not load categories" };
      return { ok: true, data };
    },
  },

  list_transactions: {
    description:
      "Search your transactions, newest first. Filter by wallet, category, kind, date range, or text in the merchant/note. Use this to find the id of a transaction before updating it. Pass kind \"refund\" for repayments: a repayment row's category is its expense's, and `repays` is the id of the expense it pays back.",
    input: listTransactionsInput,
    run: async (args: z.output<typeof listTransactionsInput>) => {
      if (args.from && args.to && args.from > args.to) {
        return { ok: false, error: "`from` must be on or before `to`" };
      }
      const supabase = await createClient();
      let query = supabase.from("transactions").select(TRANSACTION_COLUMNS).is("deleted_at", null);
      if (args.wallet_id) query = query.eq("wallet_id", args.wallet_id);
      if (args.category_id) query = query.filter("effective_category_id", "eq", args.category_id);
      if (args.kind) query = query.eq("kind", args.kind);
      if (args.from) query = query.gte("occurred_on", args.from);
      if (args.to) query = query.lte("occurred_on", args.to);
      if (args.search) {
        const pattern = ilikePattern(args.search);
        query = query.or(`merchant.ilike.${pattern},note.ilike.${pattern}`);
      }
      const { data, error } = await query
        .order("occurred_on", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(args.limit);
      if (error) return { ok: false, error: "Could not load transactions" };
      return { ok: true, data: (data as unknown as PresentRow[]).map(presentTransaction) };
    },
  },

  create_transaction: {
    description: "Record a new expense (default) or income. To record someone paying you back for an expense, use record_repayment instead.",
    input: createInput,
    run: async (args: z.output<typeof createInput>) => {
      const result = await createTransaction({
        wallet_id: args.wallet_id,
        kind: args.kind,
        amount: args.amount,
        category_id: args.category_id,
        occurred_on: args.occurred_on ?? todayLocalDate(),
        note: args.note ?? "",
        merchant: args.merchant ?? null,
      });
      return fromAction(result, result);
    },
  },

  record_repayment: {
    description:
      "Record someone paying you back for an expense (e.g. friends repaying their share of a meal). The repayment counts against that expense's category and month, while the money shows up in the wallet it landed in.",
    input: repaymentInput,
    run: async (args: z.output<typeof repaymentInput>) => {
      let walletId = args.wallet_id;
      if (!walletId) {
        const supabase = await createClient();
        const { data: expense } = await supabase
          .from("transactions")
          .select("wallet_id")
          .eq("id", args.expense_id)
          .is("deleted_at", null)
          .maybeSingle();
        if (!expense) return { ok: false, error: "Expense not found" };
        walletId = expense.wallet_id;
      }
      const result = await createRefund({
        refund_of: args.expense_id,
        wallet_id: walletId,
        amount: args.amount,
        occurred_on: args.occurred_on ?? todayLocalDate(),
        note: args.note ?? null,
        merchant: null,
      });
      return fromAction(result, result);
    },
  },

  update_transaction: {
    description:
      "Change an expense, income or repayment. Only the fields you pass change; the rest keep their current values. A repayment takes its category from its expense, so passing category_id for one is rejected. Moving a transaction to another wallet keeps its currency. Transfers can't be edited here.",
    input: updateInput,
    run: async (args: z.output<typeof updateInput>) => {
      // updateTransaction takes the whole editable row, so fill in whatever
      // the caller left out from what is stored now. The action re-loads and
      // re-checks the row itself; this read only supplies defaults.
      const supabase = await createClient();
      const { data: current } = await supabase
        .from("transactions")
        .select("amount_minor, currency_code, occurred_on, category_id, note, merchant")
        .eq("id", args.id)
        .is("deleted_at", null)
        .maybeSingle();
      if (!current) return { ok: false, error: "Transaction not found" };

      const result = await updateTransaction({
        id: args.id,
        wallet_id: args.wallet_id,
        amount:
          args.amount ?? formatAmountInput(Math.abs(current.amount_minor), minorUnitFor(current.currency_code)),
        occurred_on: args.occurred_on ?? current.occurred_on,
        category_id: args.category_id === undefined ? current.category_id : args.category_id,
        note: args.note === undefined ? current.note : args.note,
        merchant: args.merchant === undefined ? current.merchant : args.merchant,
      });
      if ("error" in result) return { ok: false, error: result.error };

      const { data: updated } = await supabase
        .from("transactions")
        .select(TRANSACTION_COLUMNS)
        .eq("id", args.id)
        .maybeSingle();
      return { ok: true, data: updated ? presentTransaction(updated as unknown as PresentRow) : { id: args.id } };
    },
  },

  delete_transaction: {
    description:
      "Delete a transaction. It can be brought back with restore_transaction. Deleting either leg of a transfer deletes both. An expense with repayments can't be deleted until its repayments are.",
    input: idInput,
    run: async (args: { id: string }) => fromAction(await softDeleteTransaction(args.id), { id: args.id, deleted: true }),
  },

  restore_transaction: {
    description: "Undo delete_transaction.",
    input: idInput,
    run: async (args: { id: string }) =>
      fromAction(await restoreTransaction(args.id), { id: args.id, restored: true }),
  },
};

export function toolList() {
  return Object.entries(TOOLS).map(([name, tool]) => {
    const inputSchema: Record<string, unknown> = z.toJSONSchema(tool.input, { io: "input" });
    delete inputSchema.$schema;
    return { name, description: tool.description, inputSchema };
  });
}

export async function callTool(name: string, rawArgs: unknown): Promise<ToolResult> {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `${where}${issue.message}` };
  }
  return tool.run(parsed.data as never);
}
