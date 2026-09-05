"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Wallet, TrendingUp, Tags, LogOut, Plus, Target, Users } from "lucide-react";
import { signOut } from "@/server/actions/auth";
import type { ThemePref } from "@/lib/supabase/current-user";
import { ThemeToggle } from "./ThemeToggle";
import { isActive } from "./nav-active";

// Mirrors TabBar's own order and labels, "Add" included. That entry used to
// exist ONLY in TabBar (`md:hidden`), while this Sidebar is `hidden md:flex`
// — so at desktop widths the two navs never overlap and /transactions/new
// had no entry point at all, reachable only by typing the URL. The
// deferred work here was the add-transaction MODAL and its keyboard
// shortcut; a plain link is not that refinement, it is the affordance the
// refinement was going to replace, and leaving it out stranded the screen.
const NAV = [
  { href: "/", label: "Home", Icon: Home },
  { href: "/wallets", label: "Wallets", Icon: Wallet },
  { href: "/transactions/new", label: "Add", Icon: Plus },
  { href: "/transactions", label: "Transactions", Icon: TrendingUp },
  { href: "/budgets", label: "Budgets", Icon: Target },
  { href: "/categories", label: "Categories", Icon: Tags },
  // Sidebar only: TabBar is already at the five tabs that fit (see its own
  // comment on six squeezing the wallet names). On mobile /household is
  // reached from the link at the top of /categories.
  { href: "/household", label: "Household", Icon: Users },
];

const NAV_HREFS = NAV.map((item) => item.href);

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cat-1)]";

/** Desktop navigation (>=768px, see TabBar for the mobile equivalent). */
export function Sidebar({ theme }: { theme: ThemePref }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary navigation"
      className="hidden w-56 shrink-0 flex-col gap-1 border-r p-4 md:flex"
      style={{ borderColor: "var(--grid)", background: "var(--surface)" }}
    >
      <p className="mb-4 px-2 text-lg font-semibold" style={{ color: "var(--ink)" }}>
        Ledger
      </p>
      {NAV.map(({ href, label, Icon }) => {
        const active = isActive(pathname, href, NAV_HREFS);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-3 rounded-md px-2 py-2 text-sm ${active ? "font-medium" : ""} ${FOCUS_RING}`}
            style={{
              background: active ? "var(--grid)" : "transparent",
              color: "var(--ink)",
              // Background-only active state measured 1.29:1 (light) /
              // 1.24:1 (dark) against the inactive rows — text colour is
              // identical, so it fails WCAG 1.4.11's 3:1 floor for UI
              // component state. A var(--cat-1) left border is the second
              // differentiator: it measures 4.34:1 (light) / 4.18:1 (dark)
              // against var(--grid), clearing 3:1 with margin in both
              // themes (see task-14-report.md for the full computation).
              borderLeft: `3px solid ${active ? "var(--cat-1)" : "transparent"}`,
            }}
          >
            <Icon size={18} aria-hidden />
            {label}
          </Link>
        );
      })}
      <div className="mt-auto flex flex-col gap-2">
        <ThemeToggle current={theme} />
        <form action={signOut}>
          <button
            type="submit"
            className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm ${FOCUS_RING}`}
            style={{ color: "var(--ink-2)" }}
          >
            <LogOut size={18} aria-hidden />
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
