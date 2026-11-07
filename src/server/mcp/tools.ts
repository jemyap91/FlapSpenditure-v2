import "server-only";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { CHANNELS } from "@/lib/channels";
import { formatAmountInput, minorUnitFor } from "@/lib/money";
import { todayLocalDate } from "@/lib/today";
import { ilikePattern, SEARCH_MAX_LENGTH } from "@/lib/transaction-filters";
import { setWalletBonus } from "@/server/actions/wallet-bonus";
import { loadCardTracker, warningsFor } from "@/server/card-tracker";
import { createRefund } from "@/server/actions/refunds";
import {
  createTransaction,
  createTransfer,
  restoreTransaction,
  softDeleteTransaction,
  updateTransaction,
  updateTransfer,
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
  channel: z.enum(CHANNELS).optional().describe("Only expenses made through this channel"),
  mismatch: z.literal(true).optional().describe("true: only expenses whose channel earned no bonus on their card"),
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
  channel: z.enum(CHANNELS).nullable().optional().describe("Leave out to use the suggestion"),
});

const updateInput = z.object({
  id: uuid,
  amount: amount.optional(),
  occurred_on: isoDate.optional(),
  category_id: uuid.nullable().optional().describe("null clears the category"),
  merchant: z.string().max(120).nullable().optional().describe("null clears it"),
  note: z.string().max(280).nullable().optional().describe("null clears it"),
  wallet_id: uuid.optional().describe("Moves the transaction to another wallet with the same currency"),
  channel: z.enum(CHANNELS).nullable().optional().describe("Leave out to keep it"),
});

const repaymentInput = z.object({
  expense_id: uuid.describe("The expense being paid back, from list_transactions"),
  amount,
  wallet_id: uuid.optional().describe("Where the money landed. Defaults to the expense's wallet; must be the same currency"),
  occurred_on: isoDate.optional().describe("When it was paid back. Defaults to today"),
  note: z.string().max(280).nullable().optional().describe("Who paid, e.g. \"Alice\""),
});

const transferInput = z.object({
  from_wallet_id: uuid.describe("The wallet the money leaves"),
  to_wallet_id: uuid.describe("The wallet the money arrives in; must be a different wallet"),
  amount: amount.describe('Amount leaving the source wallet, e.g. "200.00"'),
  amount_in: amount
    .optional()
    .describe("Amount arriving, in the destination wallet's currency. Required only when the two wallets' currencies differ"),
  occurred_on: isoDate.optional().describe("Defaults to today"),
  note: z.string().max(280).nullable().optional(),
});

const transferUpdateInput = z.object({
  id: uuid.describe("The id of either leg of the transfer, from list_transactions"),
  amount: amount.optional().describe("New amount leaving the source wallet"),
  amount_in: amount
    .optional()
    .describe("New amount arriving. For same-currency transfers it always equals amount, so leave it out"),
  occurred_on: isoDate.optional(),
  note: z.string().max(280).nullable().optional().describe("null clears it"),
  merchant: z.string().max(120).nullable().optional().describe("null clears it"),
});

const cardTrackerInput = z.object({
  on: isoDate.optional().describe("Any date inside the cycle to report on. Defaults to today"),
});

const walletBonusInput = z.object({
  wallet_id: uuid,
  bonus_channel: z.enum(CHANNELS).nullable().optional().describe("Channel that earns the bonus. null clears it; leave out to keep it"),
  cycle_start_day: z.number().int().min(1).max(31).nullable().optional().describe("Day of the month the card's cycle starts. null clears it; leave out to keep it"),
  max: amount.nullable().optional().describe("Most spend that earns the bonus per cycle, or the minimum spend when the card has no channel. null clears it; leave out to keep it"),
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
  channel?: string | null;
  channel_mismatch?: boolean | null;
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
    channel: row.channel ?? null,
    mismatch: row.channel_mismatch === true,
  };
}

type PresentRow = Parameters<typeof presentTransaction>[0];

const TRANSACTION_COLUMNS =
  "id, kind, amount_minor, currency_code, occurred_on, merchant, note, wallet_id, category_id, channel, channel_mismatch, refund_of, wallets!transactions_wallet_id_fkey(name), categories!transactions_category_id_fkey(name), repaid_expense(category_id, categories!transactions_category_id_fkey(name))";

const WARNINGS_UNCHECKED = "The expense was saved, but its warnings couldn't be checked.";

/**
 * The saved channel and warnings for an expense that is already stored. A
 * failed check must not make a saved expense look failed, so it degrades to
 * one sentence saying the warnings are unknown.
 */
async function savedOutcome(id: string): Promise<{ channel: string | null; warnings: string[] }> {
  try {
    const supabase = await createClient();
    return await warningsFor(supabase, id);
  } catch {
    // Nothing after a save may turn it into a failure, not even this read.
    let channel: string | null = null;
    try {
      const supabase = await createClient();
      const { data } = await supabase.from("transactions").select("channel").eq("id", id).maybeSingle();
      channel = data?.channel ?? null;
    } catch {}
    return { channel, warnings: [WARNINGS_UNCHECKED] };
  }
}

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
        .select("id, name, kind, currency_code, bonus_channel, cycle_start_day, bonus_cap_minor")
        .is("archived_at", null)
        .order("name");
      if (error) return { ok: false, error: "Could not load wallets" };
      return {
        ok: true,
        data: data.map((w) => ({
          id: w.id,
          name: w.name,
          kind: w.kind,
          currency: w.currency_code,
          bonus_channel: w.bonus_channel,
          cycle_start_day: w.cycle_start_day,
          max: w.bonus_cap_minor === null ? null : formatAmountInput(w.bonus_cap_minor, minorUnitFor(w.currency_code)),
        })),
      };
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
      "Search your transactions, newest first. Each expense shows its channel and whether it was a mismatch (earned no bonus on its card). Filter by wallet, category, kind, channel, mismatch, date range, or text in the merchant/note. Use this to find the id of a transaction before updating it. Pass kind \"refund\" for repayments: a repayment row's category is its expense's, and `repays` is the id of the expense it pays back.",
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
      if (args.channel) query = query.eq("channel", args.channel);
      if (args.mismatch) query = query.filter("channel_mismatch", "eq", true);
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
    description: "Record a new expense (default) or income. To record someone paying you back for an expense, use record_repayment instead. The result can carry warnings (for example, the spend won't earn the card's bonus); relay them to the user.",
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
        channel: args.channel,
      });
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true, data: { id: result.id, ...(await savedOutcome(result.id)) } };
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

  record_transfer: {
    description:
      "Move money between two of your own wallets (e.g. paying off a card from the bank, topping up savings). Records both sides at once; it is neither spending nor income. Wallets in different currencies need amount_in.",
    input: transferInput,
    run: async (args: z.output<typeof transferInput>) => {
      const result = await createTransfer({
        from_wallet_id: args.from_wallet_id,
        to_wallet_id: args.to_wallet_id,
        amount: args.amount,
        amount_in: args.amount_in,
        occurred_on: args.occurred_on ?? todayLocalDate(),
        note: args.note ?? "",
      });
      return fromAction(result, result);
    },
  },

  update_transaction: {
    description:
      "Change an expense, income or repayment. Only the fields you pass change; the rest keep their current values. A repayment takes its category from its expense, so passing category_id for one is rejected. Moving a transaction to another wallet keeps its currency. The result can carry warnings; relay them to the user. For a transfer, use update_transfer.",
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
        channel: args.channel,
      });
      if ("error" in result) return { ok: false, error: result.error };

      // After the save, so a wallet or date change is measured too.
      const outcome = await savedOutcome(args.id);

      const { data: updated } = await supabase
        .from("transactions")
        .select(TRANSACTION_COLUMNS)
        .eq("id", args.id)
        .maybeSingle();
      return {
        ok: true,
        data: { ...(updated ? presentTransaction(updated as unknown as PresentRow) : { id: args.id }), warnings: outcome.warnings },
      };
    },
  },

  update_transfer: {
    description:
      "Change a transfer's amount, date, note or merchant, given the id of either leg. Only the fields you pass change. A same-currency transfer's two sides always match, so changing amount changes both. The wallets can't be changed; delete and record it again instead.",
    input: transferUpdateInput,
    run: async (args: z.output<typeof transferUpdateInput>) => {
      // updateTransfer takes the whole pair, so fill in whatever the caller
      // left out from the two stored legs. The action re-loads and re-checks
      // both legs itself; these reads only supply defaults.
      const supabase = await createClient();
      const { data: leg } = await supabase
        .from("transactions")
        .select("kind, transfer_id")
        .eq("id", args.id)
        .is("deleted_at", null)
        .maybeSingle();
      if (!leg) return { ok: false, error: "Transfer not found" };
      if (leg.kind !== "transfer" || !leg.transfer_id) {
        return { ok: false, error: "That isn't a transfer. Use update_transaction for it." };
      }

      const { data: legs } = await supabase
        .from("transactions")
        .select("wallet_id, amount_minor, currency_code, occurred_on, note, merchant")
        .eq("transfer_id", leg.transfer_id)
        .is("deleted_at", null);
      const outLeg = legs?.find((l) => l.amount_minor < 0);
      const inLeg = legs?.find((l) => l.amount_minor > 0);
      if (!outLeg || !inLeg) return { ok: false, error: "Transfer not found" };

      const amountOut = args.amount ?? formatAmountInput(-outLeg.amount_minor, minorUnitFor(outLeg.currency_code));
      // Same currency: the database requires both sides to match, so the
      // arriving amount follows the leaving one unless the caller says otherwise.
      const amountIn =
        args.amount_in ??
        (outLeg.currency_code === inLeg.currency_code
          ? amountOut
          : formatAmountInput(inLeg.amount_minor, minorUnitFor(inLeg.currency_code)));

      const result = await updateTransfer({
        transfer_id: leg.transfer_id,
        amount_out: amountOut,
        amount_in: amountIn,
        occurred_on: args.occurred_on ?? outLeg.occurred_on,
        note: args.note === undefined ? outLeg.note : args.note,
        merchant: args.merchant === undefined ? outLeg.merchant : args.merchant,
      });
      return fromAction(result, { id: args.id, transfer_id: leg.transfer_id });
    },
  },

  delete_transaction: {
    description:
      "Delete a transaction. It can be brought back with restore_transaction. Deleting either leg of a transfer deletes both. An expense with repayments can't be deleted until its repayments are.",
    input: idInput,
    run: async (args: { id: string }) => fromAction(await softDeleteTransaction(args.id), { id: args.id, deleted: true }),
  },

  get_card_tracker: {
    description:
      "Bonus progress for each card with a monthly max: spend that earned the bonus, what is left, whether it is on pace to reach the max, and how many expenses used another channel. Measured over the cycle containing `on` (default today).",
    input: cardTrackerInput,
    run: async (args: z.output<typeof cardTrackerInput>) => {
      const today = todayLocalDate();
      try {
        const rows = await loadCardTracker(await createClient(), { on: args.on ?? today, today });
        return {
          ok: true,
          data: rows.map((r) => {
            const unit = minorUnitFor(r.currency);
            return {
              wallet: { id: r.walletId, name: r.walletName },
              currency: r.currency,
              bonus_channel: r.bonusChannel,
              goal: r.bonusChannel === null ? "min_spend" : "max",
              from: r.from,
              to: r.to,
              spent: formatAmountInput(r.spentMinor, unit),
              max: formatAmountInput(r.capMinor, unit),
              remaining: formatAmountInput(r.remainingMinor, unit),
              pace: r.pace,
              mismatch_count: r.mismatchCount,
            };
          }),
        };
      } catch {
        return { ok: false, error: "Could not load card tracker" };
      }
    },
  },

  update_wallet_bonus: {
    description:
      "Set a card wallet's bonus terms: the channel that earns the bonus, the day its cycle starts, and the max spend per cycle. Only the fields you pass change; null clears one. A max needs a cycle start day. With no channel, the max is a minimum spend that all the card's spend counts towards.",
    input: walletBonusInput,
    run: async (args: z.output<typeof walletBonusInput>) => {
      const supabase = await createClient();
      const { data: current } = await supabase
        .from("wallets")
        .select("currency_code, bonus_channel, cycle_start_day, bonus_cap_minor")
        .eq("id", args.wallet_id)
        .maybeSingle();
      if (!current) return { ok: false, error: "Wallet not found" };

      const terms = {
        bonus_channel: args.bonus_channel === undefined ? current.bonus_channel : args.bonus_channel,
        cycle_start_day: args.cycle_start_day === undefined ? current.cycle_start_day : args.cycle_start_day,
        max:
          args.max !== undefined
            ? args.max
            : current.bonus_cap_minor === null
              ? null
              : formatAmountInput(current.bonus_cap_minor, minorUnitFor(current.currency_code)),
      };
      const result = await setWalletBonus({ wallet_id: args.wallet_id, ...terms });
      return fromAction(result, { wallet_id: args.wallet_id, ...terms });
    },
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
