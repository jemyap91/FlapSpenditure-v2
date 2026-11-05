import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { CHANNELS, type Channel } from "@/lib/channels";
import { merchantKey } from "@/lib/card-bonus";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/** The channel last used for this merchant in the household, or null. */
export async function lookupMerchantChannel(
  supabase: SupabaseServerClient,
  spaceId: string,
  merchant: string | null,
): Promise<Channel | null> {
  const key = merchantKey(merchant);
  if (!key) return null;

  const { data } = await supabase
    .from("merchant_channels")
    .select("channel")
    .eq("space_id", spaceId)
    .eq("merchant_key", key)
    .maybeSingle();
  return CHANNELS.find((c) => c === data?.channel) ?? null;
}

/**
 * Remembers a correction: the channel differs from what would have been
 * suggested. Best-effort -- the transaction is already saved, so a failure
 * is logged rather than surfaced.
 */
export async function rememberMerchantChannel(
  supabase: SupabaseServerClient,
  spaceId: string,
  merchant: string | null,
  channel: Channel,
  suggested: Channel | null,
): Promise<void> {
  const key = merchantKey(merchant);
  if (!key || channel === suggested) return;

  // No updated_at trigger on this table, so the upsert sets it.
  const { error } = await supabase.from("merchant_channels").upsert(
    { space_id: spaceId, merchant_key: key, channel, updated_at: new Date().toISOString() },
    { onConflict: "space_id,merchant_key" },
  );
  if (error) console.error("Could not remember merchant channel", error.message);
}
