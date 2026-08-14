import {
  Circle,
  ShoppingBasket,
  Utensils,
  Bus,
  House,
  Plug,
  HeartPulse,
  Clapperboard,
  ShoppingBag,
  Plane,
  GraduationCap,
  Repeat,
  CircleEllipsis,
  Wallet,
  Gift,
  PiggyBank,
  CirclePlus,
  type LucideIcon,
} from "lucide-react";
import type { CategoryIcon } from "@/lib/validation/category";

/**
 * Maps every `CategoryIcon` string (src/lib/validation/category.ts) to its
 * Lucide component. `Record<CategoryIcon, LucideIcon>` means TypeScript
 * fails this file to compile if the two lists ever drift apart, in either
 * direction — a missing key or an extra one is a type error, not a runtime
 * surprise the first time someone picks the icon that isn't wired up.
 *
 * A separate module from src/lib/validation/category.ts's `CATEGORY_ICONS`
 * string list (rather than merged into it) so that module stays free of a
 * `lucide-react`/React import, and so this one can be imported by Server
 * Components rendering static icon markup without pulling in zod.
 */
export const CATEGORY_ICON_COMPONENTS: Record<CategoryIcon, LucideIcon> = {
  circle: Circle,
  "shopping-basket": ShoppingBasket,
  utensils: Utensils,
  bus: Bus,
  house: House,
  plug: Plug,
  "heart-pulse": HeartPulse,
  clapperboard: Clapperboard,
  "shopping-bag": ShoppingBag,
  plane: Plane,
  "graduation-cap": GraduationCap,
  repeat: Repeat,
  "circle-ellipsis": CircleEllipsis,
  wallet: Wallet,
  gift: Gift,
  "piggy-bank": PiggyBank,
  "circle-plus": CirclePlus,
};
