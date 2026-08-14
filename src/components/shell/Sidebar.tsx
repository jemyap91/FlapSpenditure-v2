"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Wallet, TrendingUp, Tags, LogOut } from "lucide-react";
import { signOut } from "@/server/actions/auth";
import type { ThemePref } from "@/lib/supabase/current-user";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { href: "/", label: "Home", Icon: Home },
  { href: "/wallets", label: "Wallets", Icon: Wallet },
  { href: "/transactions", label: "Transactions", Icon: TrendingUp },
  { href: "/categories", label: "Categories", Icon: Tags },
];

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
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-3 rounded-md px-2 py-2 text-sm ${FOCUS_RING}`}
            style={{ background: active ? "var(--grid)" : "transparent", color: "var(--ink)" }}
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
