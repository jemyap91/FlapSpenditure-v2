"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Wallet, Plus, TrendingUp, Tags } from "lucide-react";

const NAV = [
  { href: "/", label: "Home", Icon: Home },
  { href: "/wallets", label: "Wallets", Icon: Wallet },
  { href: "/transactions/new", label: "Add", Icon: Plus, primary: true },
  { href: "/transactions", label: "Activity", Icon: TrendingUp },
  { href: "/categories", label: "Categories", Icon: Tags },
];

/**
 * Mobile navigation (<768px, see Sidebar for the desktop equivalent).
 *
 * Inactive labels use var(--ink-2), not var(--muted): var(--muted) on
 * var(--surface) measures 3.50:1 in light mode, under WCAG AA's 4.5:1 floor
 * for this 12px text — the same class of contrast bug Task 13 fixed
 * (var(--cat-1) with literal #fff text). var(--ink-2) on var(--surface)
 * measures 7.73:1 light / 9.72:1 dark.
 */
export function TabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary navigation"
      className="fixed inset-x-0 bottom-0 flex border-t md:hidden"
      style={{ borderColor: "var(--grid)", background: "var(--surface)" }}
    >
      {NAV.map(({ href, label, Icon, primary }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
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
              style={primary ? { background: "var(--cat-1)", color: "var(--surface)" } : undefined}
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
