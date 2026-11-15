"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { isActive } from "./nav-active";
import { ADD_HREF, ALL_NAV_HREFS, LEFT_TABS, RIGHT_TABS, type NavItem } from "./nav-items";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";

/**
 * Mobile navigation (<768px, see Sidebar for the desktop equivalent): a
 * floating oxblood bar, Home · Activity · + · Cards · Wallets. The + stays
 * centre stage for adding by hand; it is a link named "Add a transaction",
 * and replaces the old bottom-right floating button.
 *
 * Active state is carried by weight and a filled pill behind the icon, not
 * colour alone. Inactive labels are on-tabbar-2 (9.1:1 on oxblood), active
 * ones on-tabbar (13.1:1).
 *
 * Active state uses the shared isActive() (see ./nav-active.ts) over every
 * shell href, so /transactions/new lights up the + and not Activity.
 */
export function TabBar() {
  const pathname = usePathname();
  const adding = isActive(pathname, ADD_HREF, ALL_NAV_HREFS);
  const tab = (item: NavItem) => (
    <Tab key={item.href} item={item} active={isActive(pathname, item.href, ALL_NAV_HREFS)} />
  );

  return (
    <nav
      aria-label="Primary navigation"
      className="fixed inset-x-3 bottom-3 z-20 flex items-center rounded-full px-2 py-2 md:hidden"
      style={{ background: "var(--tabbar)", boxShadow: "var(--shadow-float)" }}
    >
      {LEFT_TABS.map(tab)}
      <div className="flex flex-1 justify-center">
        <Link
          href={ADD_HREF}
          aria-label="Add a transaction"
          aria-current={adding ? "page" : undefined}
          className={`grid h-14 w-14 -translate-y-1 place-items-center rounded-full ${FOCUS_RING}`}
          style={{ background: "var(--candy)", color: "var(--on-bright)", boxShadow: "var(--shadow-float)" }}
        >
          <Plus size={26} strokeWidth={2.5} aria-hidden />
        </Link>
      </div>
      {RIGHT_TABS.map(tab)}
    </nav>
  );
}

function Tab({ item: { href, label, Icon }, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex flex-1 flex-col items-center gap-0.5 rounded-full py-1 text-[11px] ${active ? "font-extrabold" : "font-semibold"} ${FOCUS_RING}`}
      style={{ color: active ? "var(--on-tabbar)" : "var(--on-tabbar-2)" }}
    >
      <span
        className="grid h-8 w-12 place-items-center rounded-full"
        style={{ background: active ? "rgb(255 255 255 / 0.14)" : "transparent" }}
      >
        <Icon size={20} strokeWidth={active ? 2.4 : 2} aria-hidden />
      </span>
      {label}
    </Link>
  );
}
