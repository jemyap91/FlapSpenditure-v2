import {
  Bot,
  CreditCard,
  Home,
  Receipt,
  Repeat,
  Tags,
  Target,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export type NavItem = { href: string; label: string; Icon: LucideIcon };

/**
 * The four tabs either side of the centre + (Cherry Cola glow-up): Home and
 * Activity on the left, Cards and Wallets on the right. Budgets folded into
 * Home; Categories, Recurring, Household and Claude moved to the profile
 * menu (PROFILE_ITEMS) because they are set up once and rarely touched.
 */
export const LEFT_TABS: readonly NavItem[] = [
  { href: "/", label: "Home", Icon: Home },
  { href: "/transactions", label: "Activity", Icon: Receipt },
];

export const RIGHT_TABS: readonly NavItem[] = [
  { href: "/cards", label: "Cards", Icon: CreditCard },
  { href: "/wallets", label: "Wallets", Icon: Wallet },
];

export const PRIMARY_TABS: readonly NavItem[] = [...LEFT_TABS, ...RIGHT_TABS];

export const PROFILE_ITEMS: readonly NavItem[] = [
  { href: "/budgets", label: "Budgets", Icon: Target },
  { href: "/categories", label: "Categories", Icon: Tags },
  { href: "/recurring", label: "Recurring", Icon: Repeat },
  { href: "/household", label: "Household", Icon: Users },
  { href: "/api-access", label: "Connect Claude", Icon: Bot },
];

export const ADD_HREF = "/transactions/new";

/** Every href the shell links to, for `isActive`'s longest-match rule. */
export const ALL_NAV_HREFS: readonly string[] = [
  ...PRIMARY_TABS.map((i) => i.href),
  ADD_HREF,
  ...PROFILE_ITEMS.map((i) => i.href),
];
