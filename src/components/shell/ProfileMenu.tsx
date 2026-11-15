"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { LogOut, UserRound, X } from "lucide-react";
import { signOut } from "@/server/actions/auth";
import type { ThemePref } from "@/lib/supabase/current-user";
import { ThemeToggle } from "./ThemeToggle";
import { PROFILE_ITEMS } from "./nav-items";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

/**
 * Mobile only (`md:hidden`; the desktop Sidebar lists the same items). A
 * slim top bar with the wordmark and a profile button that opens the
 * settings that left the tab bar: Budgets, Categories, Recurring,
 * Household and Connect Claude, plus the theme and sign out.
 *
 * A disclosure (button + aria-expanded + a list of plain links), not an ARIA
 * menu: these are page links, and a disclosure needs no roving focus. It
 * closes on navigation, on Escape (returning focus to the button), and on a
 * tap outside.
 */
export function ProfileMenu({ theme }: { theme: ThemePref }) {
  const pathname = usePathname();
  // Remembers WHICH page the menu was opened on, so moving to a new page
  // closes it without an effect: the menu did its job.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const setOpen = (next: boolean) => setOpenOn(next ? pathname : null);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenOn(null);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenOn(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    // A <header> (the page's banner landmark), not a bare <div>: everything
    // on the page must sit in a landmark (axe "region"), and this bar is a
    // sibling of <main> and the tab bar's <nav>.
    <header ref={rootRef} className="relative flex items-center justify-between px-4 pt-3 md:hidden">
      <Link href="/" className={`font-display rounded-sm text-base font-extrabold ${FOCUS_RING}`} style={{ color: "var(--ink)" }}>
        Flapspenditure
      </Link>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Profile and settings"
        onClick={() => setOpen(!open)}
        className={`grid h-10 w-10 place-items-center rounded-full ${FOCUS_RING}`}
        style={{ background: "var(--surface)", color: "var(--ink)" }}
      >
        {open ? <X size={20} aria-hidden /> : <UserRound size={20} aria-hidden />}
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute right-4 top-14 z-30 w-64 rounded-3xl p-3"
        style={{ background: "var(--surface)", boxShadow: "var(--shadow-float)" }}
      >
        <ul className="flex flex-col">
          {PROFILE_ITEMS.map(({ href, label, Icon }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={pathname === href ? "page" : undefined}
                className={`flex items-center gap-3 rounded-full px-3 py-2.5 text-sm ${pathname === href ? "font-extrabold" : "font-semibold"} ${FOCUS_RING}`}
                style={{ color: "var(--ink)" }}
              >
                <Icon size={18} aria-hidden />
                {label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-col gap-2 pt-2" style={{ borderTop: "1px solid var(--grid)" }}>
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
      </div>
    </header>
  );
}
