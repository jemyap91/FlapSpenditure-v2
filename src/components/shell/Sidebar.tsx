"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, Plus } from "lucide-react";
import { signOut } from "@/server/actions/auth";
import type { ThemePref } from "@/lib/supabase/current-user";
import { ThemeToggle } from "./ThemeToggle";
import { isActive } from "./nav-active";
import { ADD_HREF, ALL_NAV_HREFS, PRIMARY_TABS, PROFILE_ITEMS, type NavItem } from "./nav-items";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

/**
 * Desktop navigation (>=768px, see TabBar for the mobile equivalent). The
 * same four tabs as the mobile bar, the add button above them (there is no
 * floating + on desktop, and without it /transactions/new would only be
 * reachable by URL), then the profile-menu destinations, which have room
 * here to stay visible.
 *
 * Active state is an oxblood pill with cream text: a fill change and a
 * weight change, so it does not rely on colour alone.
 */
export function Sidebar({ theme }: { theme: ThemePref }) {
  const pathname = usePathname();
  const link = (item: NavItem) => (
    <SidebarLink key={item.href} item={item} active={isActive(pathname, item.href, ALL_NAV_HREFS)} />
  );

  return (
    <nav
      aria-label="Primary navigation"
      className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-1 p-4 md:flex"
      style={{ background: "var(--surface)" }}
    >
      <p className="font-display mb-5 px-3 text-lg font-extrabold" style={{ color: "var(--ink)" }}>
        Flapspenditure
      </p>
      <Link
        href={ADD_HREF}
        aria-current={isActive(pathname, ADD_HREF, ALL_NAV_HREFS) ? "page" : undefined}
        className={`mb-3 flex items-center justify-center gap-2 rounded-full px-3 py-2.5 text-sm font-extrabold ${FOCUS_RING}`}
        style={{ background: "var(--candy)", color: "var(--on-bright)" }}
      >
        <Plus size={18} strokeWidth={2.5} aria-hidden />
        Add
      </Link>
      {PRIMARY_TABS.map(link)}
      <p className="mt-5 mb-1 px-3 text-[11px] font-extrabold uppercase tracking-wider" style={{ color: "var(--ink-2)" }}>
        Settings
      </p>
      {PROFILE_ITEMS.map(link)}
      <div className="mt-auto flex flex-col gap-2">
        <ThemeToggle current={theme} />
        <form action={signOut}>
          <button
            type="submit"
            className={`flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm font-semibold ${FOCUS_RING}`}
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

function SidebarLink({ item: { href, label, Icon }, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-full px-3 py-2 text-sm ${active ? "font-extrabold" : "font-semibold"} ${FOCUS_RING}`}
      style={{
        background: active ? "var(--accent)" : "transparent",
        color: active ? "var(--on-accent)" : "var(--ink)",
      }}
    >
      <Icon size={18} aria-hidden />
      {label}
    </Link>
  );
}
