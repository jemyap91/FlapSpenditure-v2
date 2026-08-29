"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/**
 * The global add-transaction button on mobile, replacing the tab bar's
 * "Add" entry (2026-08-29). `md:hidden`: the desktop Sidebar keeps its own
 * Add item, which exists because without it /transactions/new was
 * unreachable on desktop except by typing the URL (see Sidebar.tsx).
 *
 * Two places deliberately do NOT render it:
 *
 *  - `/wallets/<id>`, which already renders WalletFab in this exact corner.
 *    That button is strictly better there — it preselects the wallet and
 *    returns the user to it after saving — and two `fixed bottom-24
 *    right-6` elements would overlap, with DOM order alone deciding which
 *    one a tap reached.
 *  - `/transactions/new`, where the form it leads to is already on screen.
 *
 * The `/wallets` vs `/wallets/<id>` distinction is an EXACT match plus a
 * segment check, not `startsWith("/wallets")`, which would take the button
 * off the wallets list too. That is the same prefix collision
 * ./nav-active.ts was written for.
 *
 * A Client Component only because the decision depends on the path.
 */
export function AddFab() {
  const pathname = usePathname();

  const onSingleWallet = pathname.startsWith("/wallets/");
  const onAddScreen = pathname === "/transactions/new";
  if (onSingleWallet || onAddScreen) return null;

  return (
    /* A landmark, not a bare <a>. This renders in (app)/layout.tsx as a
       sibling of <main> and <nav>, so without one it is page content
       belonging to no region at all — axe's "all page content should be
       contained by landmarks", and a screen-reader user navigating by
       region would never reach it. WalletFab never had this problem
       because it renders INSIDE <main>; moving the same markup up to the
       layout changed its semantic context without changing its markup.

       Named, because the page already has a "Primary navigation" landmark
       (TabBar) and two unnamed navs are indistinguishable in a region
       list. */
    <nav aria-label="Quick actions">
    <Link
      href="/transactions/new"
      aria-label="Add a transaction"
      /* `bottom-24` clears the TabBar's reserved 80px (`pb-20` on <main> in
         (app)/layout.tsx), matching WalletFab. `z-10` because the layout
         renders <TabBar /> after {children}, so without an explicit
         stacking order a same-corner overlap would paint the bar on top.
         h-14 w-14 is a 56px target, comfortably over WCAG 2.5.8's 24px
         floor and Apple/Material's 44/48px guidance. */
      className={`fixed bottom-24 right-6 z-10 grid h-14 w-14 place-items-center rounded-full shadow-lg md:hidden ${FOCUS_RING}`}
      style={{ background: "var(--cat-1)", color: "var(--surface)" }}
    >
      <Plus size={24} aria-hidden />
    </Link>
    </nav>
  );
}
