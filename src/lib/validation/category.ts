import { z } from "zod";
import { Constants } from "@/lib/database.types";

/**
 * Icons offered for a category. `icon` is a NOT NULL free-text column with
 * no DB-level enum (supabase/migrations/0002_wallets_categories.sql), so —
 * same reasoning as src/lib/validation/wallet.ts's `WALLET_ICONS` — this
 * zod enum is the only thing standing between a raw POST and an arbitrary
 * string (or, worse, an emoji — banned by the design constraint, spec §6)
 * landing in the column.
 *
 * Every icon the 16 seeded default categories use (supabase/migrations/
 * 0007_seed_user.sql) is included, so a future "edit category" screen can
 * always redisplay a default category's current icon as a valid choice.
 * "circle" is added on top as the inline picker's neutral default (spec
 * §5.3: "A neutral default from the curated set"), since it isn't one of
 * the seeded 16. All 17 are confirmed-exported Lucide component names
 * (`import { Circle, ShoppingBasket, ... } from "lucide-react"`, see
 * src/lib/category-icons.ts) — this list and that file's lookup map are
 * kept in sync by `CategoryIcon` being derived from this tuple.
 */
export const CATEGORY_ICONS = [
  "circle",
  "shopping-basket",
  "utensils",
  "bus",
  "house",
  "plug",
  "heart-pulse",
  "clapperboard",
  "shopping-bag",
  "plane",
  "graduation-cap",
  "repeat",
  "circle-ellipsis",
  "wallet",
  "gift",
  "piggy-bank",
  "circle-plus",
] as const;

export type CategoryIcon = (typeof CATEGORY_ICONS)[number];

/**
 * `kind` is derived from the live `category_kind` Postgres enum via the
 * generated `Constants` (Task 14's established pattern — see
 * src/lib/validation/wallet.ts's `kind` and src/lib/validation/
 * transaction.ts's `nonTransferKind`) rather than a hand-written
 * `z.enum(["expense", "income"])` tuple that could silently drift from
 * supabase/migrations/0002_wallets_categories.sql's actual enum.
 *
 * `name`'s bound (40, trimmed) matches the CHECK constraint on `categories`
 * exactly (`length(btrim(name)) between 1 and 40`) — checked against the
 * migration rather than guessed, per this task's brief.
 */
export const categoryInput = z.object({
  /** A category belongs to a wallet (0008), not to a user — so both members
   *  of a shared wallet see one list. Validated here rather than trusted,
   *  since a Server Action is reachable by direct POST. */
  wallet_id: z.uuid(),
  name: z.string().trim().min(1, "Name is required").max(40, "Name is too long"),
  kind: z.enum(Constants.public.Enums.category_kind),
  color_slot: z.coerce.number().int().min(1).max(8).optional(),
  icon: z.enum(CATEGORY_ICONS).default("circle"),
});

export type CategoryInput = z.infer<typeof categoryInput>;

/** Which input a failed parse's first issue is about — used to set
 * `aria-invalid` on the offending field, mirroring src/lib/validation/
 * wallet.ts's `WalletField`. */
export type CategoryField = keyof CategoryInput;

const SLOTS = 8;

/**
 * Picks the least-used colour slot for a new category, lowest slot number
 * wins a tie, so colours spread across the 8-slot palette instead of
 * stacking on slot 1 (spec §5.3: "Auto-assigned to the least-used active
 * slot ... so new categories spread across the palette"). `used` is
 * whatever `color_slot` values are already active for this owner+kind —
 * there are only 8 palette slots and a user will eventually have more than
 * 8 categories per kind, so this is deliberately a many-to-8 reduction
 * (slots repeat), not a lookup that can run out.
 *
 * Out-of-range or non-integer entries in `used` are ignored rather than
 * thrown on. `used` is sourced from a live Postgres query in
 * src/server/actions/categories.ts, not raw user input — the schema's own
 * `color_slot between 1 and 8` CHECK constraint means such a value could
 * only appear here from a future migration or a manual data fix, and
 * silently excluding it from the count is safer than crashing category
 * creation over a value this function doesn't own the meaning of.
 *
 * Lives here, not in src/server/actions/categories.ts, despite being
 * conceptually a category-creation concern: that file carries a file-level
 * `"use server"` directive (needed so `createCategory`/`archiveCategory`
 * can be imported directly from Task 19's Client Component add-transaction
 * screen), and per node_modules/next/dist/docs/01-app/03-api-reference/
 * 01-directives/use-server.md, a file-level directive requires *every*
 * exported function in that file to be an `async function` — confirmed
 * live on this branch already for the identical situation with
 * `signedAmount` (see src/lib/validation/transaction.ts's doc comment and
 * this project's Task 16 report: Turbopack rejects a synchronous export
 * from a file-level-`"use server"` module with "Server Actions must be
 * async functions"). `nextColorSlot` is a genuinely synchronous pure
 * helper, so — following that exact precedent — it lives in this
 * env-var-free validation module instead, which
 * src/server/actions/categories.ts imports from rather than redeclaring.
 */
export function nextColorSlot(used: number[]): number {
  const counts = new Array<number>(SLOTS).fill(0);
  for (const s of used) {
    if (Number.isInteger(s) && s >= 1 && s <= SLOTS) counts[s - 1]! += 1;
  }
  let best = 0;
  for (let i = 1; i < SLOTS; i++) {
    if (counts[i]! < counts[best]!) best = i;
  }
  return best + 1;
}
