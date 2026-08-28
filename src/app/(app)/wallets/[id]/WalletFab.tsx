import Link from "next/link";
import { Plus } from "lucide-react";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * Task 4's per-wallet add-transaction affordance (wallet-detail plan). A
 * plain server-renderable `Link` — nothing here is interactive beyond
 * navigation, so this stays a Server Component (no "use client").
 *
 * The href hands TWO things to /transactions/new via the query string:
 *
 * - `wallet=<id>` PRESELECTS this wallet in the form. It is a hint, not an
 *   authorisation grant — that page independently re-validates the id as a
 *   uuid and matches it against its own RLS-scoped `wallets` query before
 *   trusting it (src/app/(app)/transactions/new/page.tsx's own doc
 *   comment), so this component does not need to duplicate that check.
 * - `from=wallet:<id>` is an origin IDENTIFIER, not a path. `parseOrigin`
 *   (src/lib/origin.ts) is the only thing allowed to turn it back into
 *   `/wallets/<id>` after a successful save — this component never
 *   constructs that path itself, and never passes a real path through the
 *   query string.
 *
 * The accessible name is pinned by the controller addendum: "Add a
 * transaction to <wallet name>", carried entirely by `aria-label` since the
 * visible content is only a "+" glyph (`aria-hidden` on the icon) with no
 * text a screen reader could otherwise announce.
 *
 * `fixed`, not `sticky`: this has to stay reachable while scrolling a long
 * transaction history, the same reason TransactionForm's own Save button is
 * pinned (see that component's doc comment). `bottom-24` clears the mobile
 * TabBar's own reserved 80px (`pb-20` on `<main>` in (app)/layout.tsx) with
 * margin to spare; `md:bottom-6` drops back down once the TabBar
 * (`md:hidden`) is gone. `z-10`: (app)/layout.tsx renders `<TabBar />`
 * AFTER `{children}` in DOM order, so without an explicit stacking order a
 * same-corner overlap would paint the TabBar on top of this button rather
 * than the other way round.
 */
export function WalletFab({ walletId, walletName }: { walletId: string; walletName: string }) {
  return (
    <Link
      href={`/transactions/new?wallet=${walletId}&from=wallet:${walletId}`}
      aria-label={`Add a transaction to ${walletName}`}
      className={`fixed bottom-24 right-6 z-10 grid h-14 w-14 place-items-center rounded-full shadow-lg md:bottom-6 ${FOCUS_RING}`}
      style={{ background: "var(--cat-1)", color: "var(--surface)" }}
    >
      <Plus size={24} aria-hidden />
    </Link>
  );
}
