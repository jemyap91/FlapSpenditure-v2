#!/usr/bin/env node
/**
 * Palette gate for the categorical (category-identity) colours.
 *
 * Run in CI. A colour change that breaks colour-vision separation is
 * otherwise invisible: it looks fine on the author's monitor, nobody
 * files a bug, and roughly 8% of men simply stop being able to read the
 * category charts. This turns that into a failed build.
 *
 *   node scripts/validate-palette.mjs
 *
 * Checks, per mode (all must pass):
 *   1. Lightness band     OKLCH L within the mode's band
 *   2. Chroma floor       OKLCH C >= 0.10 (below this a hue reads as grey)
 *   3. CVD separation     worst ADJACENT pair >= 8.0 ΔE (OKLab x100) under
 *                         protanopia/deuteranopia/tritanopia, simulated with
 *                         Machado-Oliveira-Fernandes 2009 at severity 1.0
 *   4. Normal-vision      worst ADJACENT pair >= 15.0 ΔE unsimulated
 *   5. Contrast           every slot >= 3:1 against its surface
 *   6. Diverging contrast `diverging.in`/`.out` >= 3:1 against BOTH the
 *                         surface AND the page background
 *
 * SCOPE: the adjacent pairlist is what stacked bars, ranked lists and lines
 * need. It is NOT sufficient for scatter / bubble / small-multiples, where any
 * two marks can touch. If such a chart is ever added, cap it at three series
 * and fold the tail into "Other" -- do not widen the palette.
 *
 * Check 6 exists because check 5 never covered `diverging.in`/`.out` at all
 * -- it was built from `raw.categorical` + `raw.surfaces` only, so a
 * diverging chart's own poles (spec §6.2: teal in / rust out) could silently
 * fail contrast with nothing here to catch it. That happened: Task 22 found
 * `diverging.in` (`#17a2a2`) at 2.962:1 against `--page` in light mode --
 * under the 3:1 floor -- even though it cleared 3:1 against `--surface`
 * (3.041:1). Charts are drawn directly on `--page` (no `--surface` card
 * wraps them, same as `CategoryBreakdown`/`CashFlow`), so `--surface` alone
 * was the wrong plane to certify against. `diverging.in` was nudged to
 * `#17a0a0` (visually indistinguishable, 3.031:1 against `--page`) and this
 * check was added so a future edit to `palette.json`'s `diverging` block
 * can't reintroduce the same gap silently.
 */

// ── palette under test ────────────────────────────────────────────────────────
// Slot order is the colour-vision-safety mechanism, not decoration. It was
// derived by searching orderings and lightness steps under the gates below.
// Re-ordering requires re-running this script.
//
// Single-sourced from ../palette.json so the validator and the app can never
// drift apart.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, "..", "palette.json"), "utf8"));

export const PALETTE = {
  light: {
    surface: raw.surfaces.light,
    page: raw.chrome.page.light,
    slots: raw.categorical.map((c) => [c.name, c.light]),
    diverging: [
      ["diverging.in", raw.diverging.in.light],
      ["diverging.out", raw.diverging.out.light],
    ],
  },
  dark: {
    surface: raw.surfaces.dark,
    page: raw.chrome.page.dark,
    slots: raw.categorical.map((c) => [c.name, c.dark]),
    diverging: [
      ["diverging.in", raw.diverging.in.dark],
      ["diverging.out", raw.diverging.out.dark],
    ],
  },
};

const BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] };
const CHROMA_FLOOR = 0.10;
const CVD_TARGET = 8.0;
const NORMAL_FLOOR = 15.0;
const CONTRAST_MIN = 3.0;

// Machado-Oliveira-Fernandes 2009, severity 1.0. The thresholds above are
// calibrated to this model, so the model is part of the standard.
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868],
           [0.114503, 0.786281, 0.099216],
           [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968],
           [0.280085, 0.672501, 0.047413],
           [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779],
           [-0.078411, 0.930809, 0.147602],
           [0.004733, 0.691367, 0.303900]],
};

// ── colour conversions ────────────────────────────────────────────────────────
const hex2srgb = (h) => {
  const s = h.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`bad hex: ${h}`);
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
};
const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin = (h) => hex2srgb(h).map(s2lin);
const relLum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export const contrast = (a, b) => {
  const [hi, lo] = [relLum(lin(a)), relLum(lin(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

function oklabFromLin([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
const oklch = (h) => { const [L, a, b] = oklabFromLin(lin(h)); return [L, Math.hypot(a, b)]; };

const simulate = (h, kind) => {
  const [r, g, b] = lin(h), M = MACHADO[kind];
  const cl = (c) => Math.max(0, Math.min(1, c));
  return [cl(M[0][0] * r + M[0][1] * g + M[0][2] * b),
          cl(M[1][0] * r + M[1][1] * g + M[1][2] * b),
          cl(M[2][0] * r + M[2][1] * g + M[2][2] * b)];
};
const deltaE = (h1, h2, kind) => {
  const a = oklabFromLin(kind ? simulate(h1, kind) : lin(h1));
  const b = oklabFromLin(kind ? simulate(h2, kind) : lin(h2));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};

// ── checks ────────────────────────────────────────────────────────────────────
function check(mode) {
  const { surface, page, slots, diverging } = PALETTE[mode];
  const [lo, hi] = BAND[mode];
  const rows = [];
  let ok = true;
  const fail = (name, detail) => { ok = false; rows.push(["FAIL", name, detail]); };
  const pass = (name, detail) => rows.push(["PASS", name, detail]);

  const bad = slots.filter(([, hex]) => { const [L] = oklch(hex); return L < lo || L > hi; });
  bad.length ? fail("Lightness band", bad.map(([n, h]) => `${n} ${h} L=${oklch(h)[0].toFixed(3)}`).join(", "))
             : pass("Lightness band", `all ${slots.length} inside L ${lo}-${hi}`);

  const grey = slots.filter(([, hex]) => oklch(hex)[1] < CHROMA_FLOOR);
  grey.length ? fail("Chroma floor", grey.map(([n, h]) => `${n} ${h} C=${oklch(h)[1].toFixed(3)}`).join(", "))
              : pass("Chroma floor", `all ${slots.length} >= ${CHROMA_FLOOR}`);

  // adjacent pairs only -- see SCOPE note at the top of this file
  let worstCvd = { d: Infinity }, worstNorm = { d: Infinity };
  for (let i = 0; i < slots.length - 1; i++) {
    const [an, ah] = slots[i], [bn, bh] = slots[i + 1];
    for (const kind of ["protan", "deutan", "tritan"]) {
      const d = deltaE(ah, bh, kind);
      if (d < worstCvd.d) worstCvd = { d, pair: `${an}<->${bn}`, kind };
    }
    const d = deltaE(ah, bh, null);
    if (d < worstNorm.d) worstNorm = { d, pair: `${an}<->${bn}` };
  }
  worstCvd.d < CVD_TARGET
    ? fail("CVD separation", `worst ${worstCvd.pair} ΔE ${worstCvd.d.toFixed(1)} (${worstCvd.kind}) < ${CVD_TARGET}`)
    : pass("CVD separation", `worst ${worstCvd.pair} ΔE ${worstCvd.d.toFixed(1)} (${worstCvd.kind})`);
  worstNorm.d < NORMAL_FLOOR
    ? fail("Normal-vision floor", `worst ${worstNorm.pair} ΔE ${worstNorm.d.toFixed(1)} < ${NORMAL_FLOOR}`)
    : pass("Normal-vision floor", `worst ${worstNorm.pair} ΔE ${worstNorm.d.toFixed(1)}`);

  const dim = slots.filter(([, hex]) => contrast(hex, surface) < CONTRAST_MIN);
  dim.length ? fail("Contrast vs surface", dim.map(([n, h]) => `${n} ${contrast(h, surface).toFixed(2)}:1`).join(", "))
             : pass("Contrast vs surface", `all ${slots.length} >= ${CONTRAST_MIN}:1`);

  // Diverging poles get their OWN check against BOTH planes they're actually
  // drawn on -- `--surface` (what check 5 above certifies for the
  // categorical slots) AND `--page` (what CashFlow/CategoryBreakdown
  // actually render on, with no card wrapper). A pair can clear one and miss
  // the other -- see the doc comment at the top of this file for the exact
  // case that happened.
  const divDim = diverging.flatMap(([n, hex]) => {
    const vsSurface = contrast(hex, surface);
    const vsPage = contrast(hex, page);
    const misses = [];
    if (vsSurface < CONTRAST_MIN) misses.push(`${n} ${hex} vs surface ${vsSurface.toFixed(3)}:1`);
    if (vsPage < CONTRAST_MIN) misses.push(`${n} ${hex} vs page ${vsPage.toFixed(3)}:1`);
    return misses;
  });
  divDim.length
    ? fail("Diverging contrast", divDim.join(", "))
    : pass(
        "Diverging contrast",
        diverging
          .map(([n, hex]) => `${n} ${contrast(hex, surface).toFixed(2)}:1 surface / ${contrast(hex, page).toFixed(2)}:1 page`)
          .join(", "),
      );

  return { rows, ok };
}

let allOk = true;
for (const mode of ["dark", "light"]) {
  const { rows, ok } = check(mode);
  allOk &&= ok;
  console.log(`\n${mode.toUpperCase()}  (surface ${PALETTE[mode].surface})`);
  for (const [status, name, detail] of rows) {
    console.log(`  [${status}] ${name.padEnd(20)} ${detail}`);
  }
}
console.log(allOk ? "\nPalette OK\n" : "\nPALETTE FAILED\n");
process.exit(allOk ? 0 : 1);
