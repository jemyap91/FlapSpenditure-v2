
/** ISO 4217 decimal exponent. Not every currency uses 2. */
export const MINOR_UNITS: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, CHF: 2, CNY: 2, SGD: 2,
  JPY: 0, KRW: 0, VND: 0,
  KWD: 3, BHD: 3, OMR: 3,
};

export const minorUnitFor = (code: string): number => MINOR_UNITS[code] ?? 2;

/**
 * Parse a user-entered amount string into POSITIVE minor units.
 * Pure string manipulation — the value never becomes a float, because
 * parseFloat("8.87") * 100 === 886.9999999999999.
 */
export function parseAmountInput(raw: string, minorUnit: number): number {
  const s = raw.trim();
  if (s === "") return 0;
  if (!/^\d*(\.\d*)?$/.test(s)) {
    throw new Error(`malformed amount: ${JSON.stringify(raw)}`);
  }
  const [whole = "", frac = ""] = s.split(".");
  const paddedFrac = frac.padEnd(minorUnit, "0").slice(0, minorUnit);
  const digits = `${whole || "0"}${paddedFrac}`;
  const n = Number(digits);
  if (!Number.isSafeInteger(n)) throw new Error(`amount out of range: ${raw}`);
  return n;
}

/** Keypad reducer. Enforces one decimal point and the currency's precision. */
export function appendDigit(current: string, digit: string, minorUnit: number): string {
  if (digit === ".") {
    if (minorUnit === 0 || current.includes(".")) return current;
    return `${current}.`;
  }
  if (!/^\d$/.test(digit)) return current;

  const dot = current.indexOf(".");
  if (dot >= 0 && current.length - dot - 1 >= minorUnit) return current;
  if (current === "0") return digit;
  return current + digit;
}

export function formatMoney(
  minorUnits: number,
  currencyCode: string,
  opts: { signed?: boolean } = {},
): string {
  const minorUnit = minorUnitFor(currencyCode);
  const abs = Math.abs(minorUnits);
  const major = abs / 10 ** minorUnit;

  const body = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
    minimumFractionDigits: minorUnit,
    maximumFractionDigits: minorUnit,
  }).format(major);

  if (!opts.signed) return minorUnits < 0 ? `−${body}` : body;
  return minorUnits < 0 ? `−${body}` : `+${body}`;
}
