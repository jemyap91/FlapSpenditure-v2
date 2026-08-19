import { createClient } from "@/lib/supabase/server";
import { addWallet } from "@/server/actions/wallets";
import { WalletForm } from "@/components/WalletForm";
import { WalletList } from "./WalletList";
import { mergeWalletBalances, type BalanceRow, type WalletRow } from "./wallet-rows";

/**
 * /wallets — the accounts screen. Both the Sidebar and the TabBar have
 * linked here since Task 14; until now the route did not exist and the nav
 * item 404'd.
 *
 * It is also the only screen that can create a SECOND wallet: /onboarding
 * creates the first and then refuses to render again (it redirects to /
 * once an active wallet exists), so before this page there was no way to
 * reach two wallets at all — and TransactionForm gates transfers on
 * `wallets.length >= 2`. Adding an account here is what unlocks them.
 *
 * `wallets_select` RLS (`is_wallet_member`) already scopes this SELECT to
 * the caller's own wallets, so no explicit `.eq("owner_id", ...)` is needed
 * for a read — the same convention src/app/(app)/categories/page.tsx
 * follows, and unlike the mutations in server/actions/wallets.ts, which
 * scope defensively anyway.
 *
 * The two reads are issued together but are not one transaction, which is
 * exactly why `mergeWalletBalances` treats a missing balance row as
 * "unknown" rather than zero — see its own doc comment.
 */
export default async function WalletsPage() {
  const supabase = await createClient();
  const [{ data: wallets, error: walletsError }, { data: balances, error: balancesError }] =
    await Promise.all([
      supabase
        .from("wallets")
        .select("id, name, kind, currency_code, color_slot, icon")
        .is("archived_at", null)
        .order("created_at"),
      supabase.rpc("get_wallet_balances"),
    ]);

  // A query error is not an empty result — `data` comes back null for both,
  // so skipping this check would render "No accounts yet" (and, worse, the
  // last-wallet guard's own disabled state) on a transient DB blip. Thrown,
  // not redirected, matching (app)/layout.tsx and (app)/categories/page.tsx.
  if (walletsError) throw new Error("Failed to load wallets");
  if (balancesError) throw new Error("Failed to load balances");

  const rows = mergeWalletBalances(
    (wallets ?? []) as WalletRow[],
    (balances ?? []) as BalanceRow[],
  );

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-6 text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Accounts
      </h1>

      <WalletList wallets={rows} />

      {/* `addWallet`, not `createWallet`: the latter redirects to / on
          success, which is right for onboarding and wrong here — adding a
          second account should leave the user looking at their accounts. */}
      <section aria-labelledby="add-wallet-heading" className="mt-8">
        <h2 id="add-wallet-heading" className="mb-3 text-sm font-medium uppercase tracking-wide" style={{ color: "var(--ink-2)" }}>
          Add an account
        </h2>
        <WalletForm action={addWallet} submitLabel="Add account" pendingLabel="Adding…" />
      </section>
    </div>
  );
}
