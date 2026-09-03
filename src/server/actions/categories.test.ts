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
import { categoryInput, nextColorSlot } from "@/lib/validation/category";
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

describe("categoryInput — wallet scoping", () => {
  it("requires a wallet_id, since a category now belongs to a wallet", () => {
    const result = categoryInput.safeParse({ name: "Vet", kind: "expense", icon: "circle" });
    expect(result.success).toBe(false);
  });

  it("accepts a uuid wallet_id", () => {
    const result = categoryInput.safeParse({
      name: "Vet",
      kind: "expense",
      icon: "circle",
      // A real RFC-4122 v4 uuid, not the brief's literal
      // "11111111-1111-1111-1111-111111111111" — this zod version's
      // `z.uuid()` (v4.4.3) validates the version/variant nibbles, and that
      // literal fails them (its 4th group starts with "1", not one of
      // 8/9/a/b), so it would fail this "accepts a uuid" case for the wrong
      // reason. Every real wallet_id here comes from Postgres's
      // gen_random_uuid(), which always produces a valid v4 uuid, so this
      // stricter check is correct for production; only the test fixture
      // needed to change.
      wallet_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a wallet_id that is not a uuid, rather than passing it to Postgres", () => {
    const result = categoryInput.safeParse({
      name: "Vet",
      kind: "expense",
      icon: "circle",
      wallet_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});
