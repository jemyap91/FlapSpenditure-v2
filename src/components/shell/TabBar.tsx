"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Wallet, TrendingUp, Tags, Target } from "lucide-react";
import { isActive } from "./nav-active";

const NAV = [
  { href: "/", label: "Home", Icon: Home },
  { href: "/wallets", label: "Wallets", Icon: Wallet },
  { href: "/transactions", label: "Activity", Icon: TrendingUp },
  { href: "/budgets", label: "Budgets", Icon: Target },
  { href: "/categories", label: "Categories", Icon: Tags },
];

const NAV_HREFS = NAV.map((item) => item.href);

/**
 * Mobile navigation (<768px, see Sidebar for the desktop equivalent).
 *
 * Inactive labels use var(--ink-2), not var(--muted): var(--muted) on
 * var(--surface) measures 3.50:1 in light mode, under WCAG AA's 4.5:1 floor
 * for this 12px text — the same class of contrast bug Task 13 fixed
 * (var(--cat-1) with literal #fff text). var(--ink-2) on var(--surface)
 * measures 7.73:1 light / 9.72:1 dark.
 *
 * Active state uses the shared isActive() (see ./nav-active.ts), not a bare
 * `pathname.startsWith(href)`: a bare prefix check made "/transactions"
 * (Activity) report aria-current="page" on "/transactions/new" as well.
 * That collision predates 2026-08-29 — when "Add" was a tab here too — and
 * the guard is kept because Activity's prefix still matches the add screen.
 *
 * "Add" is no longer a tab. It moved to AddFab, a bottom-right floating
 * button (2026-08-29): six tabs left the wallet names on /wallets squeezed,
 * and a primary action reads better as a button than as a peer of five
 * navigation destinations. The desktop Sidebar keeps its own Add item —
 * there is no FAB there, and without that item /transactions/new was once
 * unreachable on desktop except by URL.
 */
export function TabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary navigation"
      className="fixed inset-x-0 bottom-0 flex border-t md:hidden"
      style={{ borderColor: "var(--grid)", background: "var(--surface)" }}
    >
      {NAV.map(({ href, label, Icon }) => {
        const active = isActive(pathname, href, NAV_HREFS);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className="flex flex-1 flex-col items-center gap-1 py-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]"
            style={{ color: active ? "var(--ink)" : "var(--ink-2)" }}
          >
            <span
              className="grid h-9 w-9 place-items-center rounded-full"
            >
              <Icon size={20} aria-hidden />
            </span>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
