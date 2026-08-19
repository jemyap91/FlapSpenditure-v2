"use client";

import { useState, useTransition } from "react";
import { Landmark, CreditCard } from "lucide-react";
import { archiveWallet } from "@/server/actions/wallets";
import { formatMoney } from "@/lib/money";
import { slotVar } from "@/lib/palette";
import type { WalletWithBalance } from "./wallet-rows";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * Wallet icons are a closed two-value set (`WALLET_ICONS` in
 * src/lib/validation/wallet.ts), unlike categories' open icon list — so
 * this is a plain lookup with a `kind`-derived fallback rather than
 * src/lib/category-icons.ts's registry.
 */
const WALLET_ICON_COMPONENTS = {
  landmark: Landmark,
  "credit-card": CreditCard,
} as const;

/**
 * The list half of /wallets: current balances, plus per-row Archive.
 *
 * A Client Component only because Archive is interactive — the wallet data
 * itself is fetched in page.tsx (a Server Component) and passed down, the
 * same split src/app/(app)/categories/page.tsx + CategorySection.tsx use.
 *
 * There is no Undo here, deliberately, unlike TransactionList's delete.
 * Archiving is already reversible in principle (`archived_at` is a soft
 * flag) but nothing in this app un-archives yet, so offering "Undo" would
 * promise a path that doesn't exist. Blocking the one irreversible-feeling
 * case instead — archiving your last wallet — is what the guard below does.
 */
export function WalletList({ wallets }: { wallets: WalletWithBalance[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, start] = useTransition();

  // The app requires at least one active wallet to function: (app)/layout.tsx
  // redirects a user with zero active wallets to /onboarding. Archiving the
  // last one would therefore teleport the user out of this screen into
  // setup — so it's blocked here rather than allowed and then explained.
  // `archiveWallet` re-checks this server-side (a Server Function is
  // reachable by direct POST, per that module's own doc comment); this is
  // the UI half, not the enforcement.
  const isLastWallet = wallets.length === 1;

  function archive(id: string) {
    setError(null);
    setPendingId(id);
    start(async () => {
      // `archiveWallet` RETURNS its error rather than throwing — a thrown
      // message would reach the browser as an opaque digest in production
      // (see that action's own doc comment), and the last-wallet refusal
      // is guidance the user has to be able to read.
      const res = await archiveWallet(id);
      if (res.error) setError(res.error);
      setPendingId(null);
    });
  }

  if (!wallets.length) {
    return (
      <p className="py-8 text-sm" style={{ color: "var(--ink-2)" }}>
        No accounts yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Always mounted, not conditionally rendered — the same reasoning
          every other form in this codebase documents: a role="alert" node
          that appears and gets its text in the same instant is not
          reliably announced, while one that is already there and changes
          is. Empty when there's nothing to say. */}
      <p role="alert" className="text-sm" style={{ color: "var(--neg)" }}>
        {error}
      </p>

      <ul className="flex flex-col">
        {wallets.map((w) => {
          const Icon = WALLET_ICON_COMPONENTS[w.icon as keyof typeof WALLET_ICON_COMPONENTS] ??
            (w.kind === "card" ? CreditCard : Landmark);
          const archiving = pendingId === w.id;
          return (
            <li
              key={w.id}
              className="flex items-center gap-3 border-b px-1 py-3"
              style={{ borderColor: "var(--grid)" }}
            >
              {/* Colour is never the only cue (spec §6.1/§6.3): the slot
                  colour tints the glyph, but the glyph shape and the name
                  beside it are what actually identify the wallet. */}
              <Icon aria-hidden size={18} style={{ color: slotVar(w.color_slot) }} className="shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate" style={{ color: "var(--ink)" }}>
                  {w.name}
                </span>
                <span className="block text-xs" style={{ color: "var(--ink-2)" }}>
                  {w.kind === "card" ? "Card" : "Bank"} · {w.currency_code}
                </span>
              </span>
              {/* `balanceMinor === null` means the balance was not computed
                  (see mergeWalletBalances) — an em dash states that, where
                  "$0.00" would assert a balance this app never derived.
                  Unsigned `formatMoney` still prefixes a real minus for a
                  negative balance (a card can genuinely be overdrawn) but
                  adds no "+" to a positive one, which is what a balance
                  should read like. */}
              <span
                className="shrink-0 tabular-nums"
                style={{
                  color:
                    w.balanceMinor === null
                      ? "var(--ink-2)"
                      : w.balanceMinor < 0
                        ? "var(--neg)"
                        : "var(--ink)",
                }}
              >
                {w.balanceMinor === null ? "—" : formatMoney(w.balanceMinor, w.currency_code)}
              </span>
              <button
                type="button"
                aria-label={`Archive ${w.name}`}
                disabled={isLastWallet || archiving}
                onClick={() => archive(w.id)}
                className={`shrink-0 text-xs underline disabled:opacity-60 ${FOCUS_RING}`}
                style={{ color: "var(--ink-2)" }}
              >
                {archiving ? "Archiving…" : "Archive"}
              </button>
            </li>
          );
        })}
      </ul>

      {isLastWallet && (
        <p className="text-xs" style={{ color: "var(--ink-2)" }}>
          You need at least one account, so this one can’t be archived. Add another first.
        </p>
      )}
    </div>
  );
}
