// src/lib/palette.test.ts
import { describe, it, expect } from "vitest";
import { PALETTE, slotVar, SLOT_COUNT } from "./palette";

describe("palette", () => {
  it("exposes exactly 8 categorical slots", () => {
    expect(SLOT_COUNT).toBe(8);
    expect(PALETTE.categorical).toHaveLength(8);
  });

  it("maps a slot number to its CSS variable", () => {
    expect(slotVar(1)).toBe("var(--cat-1)");
    expect(slotVar(8)).toBe("var(--cat-8)");
  });

  it("rejects out-of-range slots rather than silently wrapping", () => {
    expect(() => slotVar(0)).toThrow();
    expect(() => slotVar(9)).toThrow();
  });
});
