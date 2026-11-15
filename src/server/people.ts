import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { peopleFor, type Member, type Person } from "@/lib/people";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Everyone in the viewer's households, coloured (see lib/people.ts).
 *
 * Read through `get_space_members` because `profiles` is own-row only under
 * RLS: a plain select could not name a partner. The viewer is always
 * included, as "You" when they are in no household yet, so their own
 * wallets never read as someone else's.
 */
export async function loadPeople(supabase: SupabaseServerClient, viewerId: string): Promise<Map<string, Person>> {
  const { data, error } = await supabase.rpc("get_space_members");
  // A failed read must not quietly recolour every wallet as "someone else".
  if (error) throw new Error("Failed to load household members");
  const members: Member[] = (data ?? []).map((m) => ({ user_id: m.user_id, display_name: m.display_name }));
  if (!members.some((m) => m.user_id === viewerId)) members.push({ user_id: viewerId, display_name: "You" });
  return peopleFor(members);
}
