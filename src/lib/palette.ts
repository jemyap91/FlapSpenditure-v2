import raw from "../../palette.json";

export type Slot = number;

/**
 * Derived from palette.json rather than written as a literal, so the count,
 * the CSS variables and the validator can never disagree: `slotVar` builds
 * `--cat-N` for N up to this number, `scripts/validate-palette.mjs` checks
 * exactly the same array, and adding a ninth colour to the JSON without a
 * matching `--cat-9` in globals.css is the one remaining way to break it —
 * which the palette test pins.
 *
 * Widened from 8 to 16 (2026-09-03). The ceiling is not arbitrary: the
 * validator requires every ADJACENT slot pair to stay >= 8.0 ΔE apart under
 * simulated protanopia/deuteranopia/tritanopia in both themes, and a search
 * over the whole sRGB gamut inside the lightness band tops out at 17 slots.
 * 16 leaves headroom; the eight added occupy the cool arc (teal through
 * violet) the original eight never used, and every new adjacent pair scores
 * >= 13.8 ΔE — better than the original palette's own worst pair (10.0).
 */
export const SLOT_COUNT = raw.categorical.length;
export const PALETTE = raw;

/** CSS variable for a category/wallet colour slot. Throws on out-of-range. */
export function slotVar(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) {
    throw new RangeError(`color_slot must be 1-${SLOT_COUNT}, got ${slot}`);
  }
  return `var(--cat-${slot})`;
}
