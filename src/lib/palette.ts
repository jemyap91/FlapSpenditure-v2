import raw from "../../palette.json";

export type Slot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const SLOT_COUNT = 8;
export const PALETTE = raw;

/** CSS variable for a category/wallet colour slot. Throws on out-of-range. */
export function slotVar(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) {
    throw new RangeError(`color_slot must be 1-${SLOT_COUNT}, got ${slot}`);
  }
  return `var(--cat-${slot})`;
}
