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
import { nextColorSlot } from "@/lib/validation/category";

describe("nextColorSlot", () => {
  it("picks the first unused slot", () => {
    expect(nextColorSlot([1, 2, 3])).toBe(4);
  });

  it("spreads across the palette instead of stacking on slot 1", () => {
    // every slot used once except 6 -> pick 6
    expect(nextColorSlot([1, 2, 3, 4, 5, 7, 8])).toBe(6);
  });

  it("picks the least-used slot once all 8 are taken", () => {
    expect(nextColorSlot([1, 1, 2, 2, 3, 4, 5, 6, 7, 8])).toBe(3);
  });

  it("returns 1 for an empty set", () => {
    expect(nextColorSlot([])).toBe(1);
  });

  it("ignores out-of-range and non-integer values rather than crashing", () => {
    // 0, 9, -1 and 1.5 are all invalid `color_slot` values (the column's own
    // CHECK constraint is `between 1 and 8`) and are silently excluded from
    // the count; only the two valid `1`s are counted, so slot 2 (count 0)
    // wins over slot 1 (count 2).
    expect(nextColorSlot([0, 9, -1, 1.5, 1, 1])).toBe(2);
  });

  it("still returns a value in range when `used` is entirely out-of-range", () => {
    expect(nextColorSlot([0, 9, 100, -5])).toBe(1);
  });
});
