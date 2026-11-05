"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { walletBonusInput } from "@/lib/validation/wallet";
import { parseAmountInput, minorUnitFor } from "@/lib/money";

/**
 * Saves a wallet's card bonus terms through `set_wallet_bonus` (0033), which
 * any member of the wallet may call -- unlike `wallets_write`, which is
 * owner-only, and which a plain UPDATE of these columns is refused by.
 * Re-validates like every Server Function, since it is reachable by direct
 * POST. Omitting all three values clears the terms.
 */
export async function setWalletBonus(raw: unknown): Promise<{ ok: true } | { error: string }> {
  const parsed = walletBonusInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { wallet_id, bonus_channel, cycle_start_day, max } = parsed.data;

  // The cap is in the wallet's own currency, so its minor unit comes from
  // the wallet row (RLS hides one the caller is not a member of).
  let capMinor: number | null = null;
  if (max) {
    const { data: wallet } = await supabase
      .from("wallets")
      .select("currency_code")
      .eq("id", wallet_id)
      .maybeSingle();
    if (!wallet) return { error: "Wallet not found" };
    try {
      capMinor = parseAmountInput(max, minorUnitFor(wallet.currency_code));
    } catch {
      return { error: "Max is not a valid amount" };
    }
    if (capMinor <= 0) return { error: "Max must be more than zero" };
  }

  // The generated types refuse an explicit null for a defaulted argument.
  const { error } = await supabase.rpc("set_wallet_bonus", {
    p_wallet_id: wallet_id,
    p_channel: bonus_channel ?? undefined,
    p_cycle_start_day: cycle_start_day ?? undefined,
    p_cap_minor: capMinor ?? undefined,
  });
  if (error) return { error: "Could not save card terms. Please try again." };

  revalidatePath("/");
  revalidatePath("/wallets");
  return { ok: true };
}
