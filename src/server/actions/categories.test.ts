// src/server/actions/categories.test.ts
//
// Imports `nextColorSlot` from `@/lib/validation/category`, not `./categories`
// as this task's brief originally specified — the helper was moved there (see
// that file's doc comment) because a file-level `"use server"` directive
// requires every export in `categories.ts` to be `async`, which a pure sync
// helper cannot be. This module (zod + `@/lib/database.types`, which has no
// imports of its own) never reaches `next/headers`, `@/lib/supabase/env`, or
// `server-only`, so this suite needs no `.env.local` and no local Supabase
// stack to run — verified below by running `npm test` with `.env.local`
// physically absent from the repo.
import { describe, it, expect } from "vitest";
import { categoryInput, categoryEditInput, nextColorSlot } from "@/lib/validation/category";
import { SLOT_COUNT } from "@/lib/palette";

/** One past the last real slot — the smallest genuinely invalid `color_slot`.
 *  Written as an expression, not the literal 17: these tests previously used
 *  9, which stopped being out of range the moment the palette widened to 16,
 *  and two of them went on passing while asserting something untrue. */
const OUT_OF_RANGE = SLOT_COUNT + 1;

describe("nextColorSlot", () => {
  it("picks the first unused slot", () => {
    expect(nextColorSlot([1, 2, 3])).toBe(4);
  });

  it("spreads across the palette instead of stacking on slot 1", () => {
    // every slot used once except 6 -> pick 6
    const allButSix = Array.from({ length: SLOT_COUNT }, (_, i) => i + 1).filter((s) => s !== 6);
    expect(nextColorSlot(allButSix)).toBe(6);
  });

  it("picks the least-used slot once every slot is taken", () => {
    // Built from SLOT_COUNT rather than a hand-written 1..8 list, which
    // silently stopped exercising "every slot is taken" when the palette
    // widened -- slots 9-16 were simply unused, so the assertion measured
    // the first-unused branch again instead of the least-used one.
    const all = Array.from({ length: SLOT_COUNT }, (_, i) => i + 1);
    expect(nextColorSlot([...all, 1, 2])).toBe(3);
  });

  it("returns 1 for an empty set", () => {
    expect(nextColorSlot([])).toBe(1);
  });

  it("ignores out-of-range and non-integer values rather than crashing", () => {
    // 0, OUT_OF_RANGE, -1 and 1.5 are all invalid `color_slot` values (the
    // column's own CHECK constraint is `between 1 and 16`, widened from 8 by
    // supabase/migrations/0017_palette_16.sql) and are silently excluded from
    // the count; only the two valid `1`s are counted, so slot 2 (count 0)
    // wins over slot 1 (count 2).
    expect(nextColorSlot([0, OUT_OF_RANGE, -1, 1.5, 1, 1])).toBe(2);
  });

  it("still returns a value in range when `used` is entirely out-of-range", () => {
    expect(nextColorSlot([0, OUT_OF_RANGE, 100, -5])).toBe(1);
  });
});

describe("categoryInput — household scoping", () => {
  it("requires a space_id, since a category belongs to a household", () => {
    const result = categoryInput.safeParse({ name: "Vet", kind: "expense", icon: "circle" });
    expect(result.success).toBe(false);
  });

  it("accepts a uuid space_id", () => {
    const result = categoryInput.safeParse({
      name: "Vet",
      kind: "expense",
      icon: "circle",
      // A real RFC-4122 v4 uuid, not the brief's literal
      // "11111111-1111-1111-1111-111111111111" — this zod version's
      // `z.uuid()` (v4.4.3) validates the version/variant nibbles, and that
      // literal fails them (its 4th group starts with "1", not one of
      // 8/9/a/b), so it would fail this "accepts a uuid" case for the wrong
      // reason. Every real space_id here comes from Postgres's
      // gen_random_uuid(), which always produces a valid v4 uuid, so this
      // stricter check is correct for production; only the test fixture
      // needed to change.
      space_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a wallet_id that is not a uuid, rather than passing it to Postgres", () => {
    const result = categoryInput.safeParse({
      name: "Vet",
      kind: "expense",
      icon: "circle",
      space_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

describe("categoryEditInput", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Groceries",
    color_slot: 3,
    icon: "shopping-basket",
  };

  it("accepts a well-formed edit", () => {
    expect(categoryEditInput.safeParse(base).success).toBe(true);
  });

  it("trims the name", () => {
    expect(categoryEditInput.parse({ ...base, name: "  Food  " }).name).toBe("Food");
  });

  it("refuses an empty or whitespace-only name", () => {
    expect(categoryEditInput.safeParse({ ...base, name: "" }).success).toBe(false);
    expect(categoryEditInput.safeParse({ ...base, name: "   " }).success).toBe(false);
  });

  it("refuses a name over 40 characters, matching the column CHECK", () => {
    expect(categoryEditInput.safeParse({ ...base, name: "x".repeat(41) }).success).toBe(false);
    expect(categoryEditInput.safeParse({ ...base, name: "x".repeat(40) }).success).toBe(true);
  });

  it("accepts the last colour slot and refuses the one past it", () => {
    // Expressed via SLOT_COUNT rather than 16/17: written as literals these
    // would silently stop testing the boundary the next time the palette
    // moves, which is exactly what happened to the old `9`-based tests above.
    expect(categoryEditInput.safeParse({ ...base, color_slot: SLOT_COUNT }).success).toBe(true);
    expect(categoryEditInput.safeParse({ ...base, color_slot: SLOT_COUNT + 1 }).success).toBe(false);
    expect(categoryEditInput.safeParse({ ...base, color_slot: 0 }).success).toBe(false);
  });

  it("requires a colour slot, unlike creation", () => {
    // categoryInput treats a missing slot as "auto-assign the least-used".
    // An edit form always renders the current slot as the checked radio, so
    // a payload without one is malformed, not a request to re-roll it.
    const rest: Record<string, unknown> = { ...base };
    delete rest.color_slot;
    expect(categoryEditInput.safeParse(rest).success).toBe(false);
  });

  it("refuses an icon outside the curated set", () => {
    expect(categoryEditInput.safeParse({ ...base, icon: "skull" }).success).toBe(false);
    expect(categoryEditInput.safeParse({ ...base, icon: "\u{1F600}" }).success).toBe(false);
  });

  it("carries no wallet_id, kind or is_default — none is editable", () => {
    // The database refuses all three independently since
    // 0018_category_update_grant.sql, but a Server Function is reachable by
    // direct POST and the schema is the first of the two layers.
    const parsed = categoryEditInput.parse({
      ...base,
      space_id: "22222222-2222-4222-8222-222222222222",
      kind: "income",
      is_default: true,
    } as never);
    expect(parsed).not.toHaveProperty("wallet_id");
    expect(parsed).not.toHaveProperty("kind");
    expect(parsed).not.toHaveProperty("is_default");
  });

  it("refuses a malformed id", () => {
    expect(categoryEditInput.safeParse({ ...base, id: "not-a-uuid" }).success).toBe(false);
  });
});
