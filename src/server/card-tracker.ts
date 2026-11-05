import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { CHANNELS, type Channel } from "@/lib/channels";
import { cycleFor, expenseWarnings, isMismatch, paceFor } from "@/lib/card-bonus";
import { todayLocalDate } from "@/lib/today";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type CardTrackerRow = {
  walletId: string;
  walletName: string;
  currency: string;
  bonusChannel: Channel;
  capMinor: number;
  from: string;
  to: string;
  spentMinor: number;
  remainingMinor: number;
  pace: "reached" | "on_pace" | "under";
  mismatchCount: number;
};

const asChannel = (value: string | null): Channel | null =>
  CHANNELS.find((c) => c === value) ?? null;

/** A failed read must not look like a card with nothing spent. */
function fail(log: string, error: { message: string }, message = "Failed to load card tracker"): never {
  console.error(log, error.message);
  throw new Error(message);
}

/**
 * Bonus progress for every card with a max, measured over the cycle that
 * contains `on`. The only place tracker figures are calculated. Plain table
 * reads under RLS, so a viewer sees only wallets they belong to.
 */
export async function loadCardTracker(
  supabase: SupabaseServerClient,
  opts: { on: string; today: string; excludeTransactionId?: string },
): Promise<CardTrackerRow[]> {
  const { data: wallets, error: walletsError } = await supabase
    .from("wallets")
    .select("id, name, currency_code, bonus_channel, cycle_start_day, bonus_cap_minor")
    .is("archived_at", null)
    .not("bonus_cap_minor", "is", null)
    .order("name");
  if (walletsError) fail("Could not load card wallets", walletsError);

  const rows: CardTrackerRow[] = [];
  for (const w of wallets ?? []) {
    const bonusChannel = asChannel(w.bonus_channel);
    if (!bonusChannel || w.cycle_start_day === null || w.bonus_cap_minor === null) continue;

    const { from, to } = cycleFor(opts.on, w.cycle_start_day);
    let query = supabase
      .from("transactions")
      .select("amount_minor, channel")
      .eq("wallet_id", w.id)
      .eq("kind", "expense")
      .is("deleted_at", null)
      .gte("occurred_on", from)
      .lte("occurred_on", to);
    if (opts.excludeTransactionId) query = query.neq("id", opts.excludeTransactionId);
    const { data: expenses, error: expensesError } = await query;
    if (expensesError) fail("Could not load card expenses", expensesError);

    let spentMinor = 0;
    let mismatchCount = 0;
    for (const e of expenses ?? []) {
      const channel = asChannel(e.channel);
      if (channel === bonusChannel) spentMinor += Math.abs(e.amount_minor);
      else if (isMismatch(channel, bonusChannel)) mismatchCount += 1;
    }

    rows.push({
      walletId: w.id,
      walletName: w.name,
      currency: w.currency_code,
      bonusChannel,
      capMinor: w.bonus_cap_minor,
      from,
      to,
      spentMinor,
      remainingMinor: Math.max(0, w.bonus_cap_minor - spentMinor),
      pace: paceFor({
        spentMinor,
        capMinor: w.bonus_cap_minor,
        from,
        to,
        today: opts.today,
      }),
      mismatchCount,
    });
  }
  return rows;
}

/**
 * The warnings a saved expense raises, measured against the cycle it falls
 * in and leaving itself out of the spend before it. Only expenses warn.
 */
export async function warningsFor(
  supabase: SupabaseServerClient,
  transactionId: string,
): Promise<{ channel: Channel | null; warnings: string[] }> {
  const none = { channel: null, warnings: [] };

  const { data: tx, error: txError } = await supabase
    .from("transactions")
    .select("kind, wallet_id, channel, amount_minor, occurred_on")
    .eq("id", transactionId)
    .maybeSingle();
  if (txError) fail("Could not load transaction for warnings", txError, "Failed to load warnings");
  if (!tx || tx.kind !== "expense") return none;

  const { data: wallet, error: walletError } = await supabase
    .from("wallets")
    .select("name, currency_code, bonus_channel, bonus_cap_minor")
    .eq("id", tx.wallet_id)
    .maybeSingle();
  if (walletError) fail("Could not load wallet for warnings", walletError, "Failed to load warnings");
  if (!wallet) return none;

  const tracker = await loadCardTracker(supabase, {
    on: tx.occurred_on,
    today: todayLocalDate(),
    excludeTransactionId: transactionId,
  });
  const row = tracker.find((r) => r.walletId === tx.wallet_id);

  const channel = asChannel(tx.channel);
  return {
    channel,
    warnings: expenseWarnings({
      walletName: wallet.name,
      bonusChannel: asChannel(wallet.bonus_channel),
      capMinor: wallet.bonus_cap_minor,
      currency: wallet.currency_code,
      channel,
      amountMinor: Math.abs(tx.amount_minor),
      spentBeforeMinor: row ? row.spentMinor : null,
    }),
  };
}
