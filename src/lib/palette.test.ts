// src/lib/palette.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { PALETTE, slotVar, SLOT_COUNT } from "./palette";

describe("palette", () => {
  it("exposes exactly 16 categorical slots", () => {
    // The literal is the point: SLOT_COUNT is derived from palette.json, so
    // asserting the two agree would be a tautology that passes after someone
    // deletes an entry. This pins the intended number instead.
    expect(SLOT_COUNT).toBe(16);
    expect(PALETTE.categorical).toHaveLength(16);
  });

  it("maps a slot number to its CSS variable", () => {
    expect(slotVar(1)).toBe("var(--cat-1)");
    expect(slotVar(SLOT_COUNT)).toBe(`var(--cat-${SLOT_COUNT})`);
  });

  it("rejects out-of-range slots rather than silently wrapping", () => {
    expect(() => slotVar(0)).toThrow();
    expect(() => slotVar(SLOT_COUNT + 1)).toThrow();
  });

  /**
   * The gap `slotVar` cannot see. It builds `var(--cat-N)` from a number and
   * trusts the stylesheet to define it; an undefined custom property is not
   * an error in CSS, it just resolves to nothing, so a slot added to
   * palette.json without a matching `--cat-N` renders as an invisible swatch
   * and an uncoloured icon. Nothing else in the suite or in
   * scripts/validate-palette.mjs looks at globals.css at all — the validator
   * reads palette.json, which is the half that would still be right.
   *
   * All three theme blocks are checked because they are three separate
   * declarations: `:root` (light), the `prefers-color-scheme: dark` media
   * query, and `:root[data-theme="dark"]` for the explicit toggle. Defining
   * a new slot in one and forgetting the others is the likelier mistake, and
   * it fails only in the theme nobody tested in.
   */
  it("defines every slot as a CSS variable in all three theme blocks", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const blocks = css.split(/(?=:root|@media)/).filter((b) => b.includes("--cat-1:"));
    expect(blocks).toHaveLength(3);

    for (const [i, block] of blocks.entries()) {
      const missing = Array.from({ length: SLOT_COUNT }, (_, n) => n + 1).filter(
        (slot) => !new RegExp(`--cat-${slot}\\s*:`).test(block),
      );
      expect(missing, `theme block ${i} is missing --cat-N for: ${missing.join(", ")}`).toEqual([]);
    }
  });
});
