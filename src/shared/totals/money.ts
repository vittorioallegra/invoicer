/** Rounds `n / d` half up (away from zero) to an integer; `d` must be positive. */
export function divRound(n: number, d: number): number {
  const q = Math.floor((2 * Math.abs(n) + d) / (2 * d));
  return n < 0 && q !== 0 ? -q : q;
}

const GROUPED = /^\d{1,3}([.,]\d{3})+$/;

/**
 * Parses a typed amount into integer cents, or null when it is not a valid amount.
 * Accepts `1040`, `1040,00`, `1.040,00`, `1,040.00`, `1040.5` and a leading minus.
 * A single separator followed by exactly three digits is a thousands separator (`1.040`).
 */
export function parseMoney(input: string): number | null {
  let s = input.replace(/[\s €$]/g, "");
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (s === "") return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let integerPart: string;
  let fraction = "";

  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the last one is the decimal separator, the other groups thousands.
    const decimalAt = Math.max(lastDot, lastComma);
    const thousandsSep = lastDot > lastComma ? "," : ".";
    integerPart = s.slice(0, decimalAt);
    fraction = s.slice(decimalAt + 1);
    if (!integerPart.includes(thousandsSep) || integerPart.includes(s[decimalAt] as string)) {
      return null;
    }
    if (!GROUPED.test(integerPart)) return null;
    integerPart = integerPart.split(thousandsSep).join("");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = s.split(sep);
    const last = parts[parts.length - 1] as string;
    if (parts.length > 2 || (last.length === 3 && parts[0] !== "0")) {
      // Thousands separator(s) only.
      if (!GROUPED.test(s)) return null;
      integerPart = parts.join("");
    } else {
      integerPart = parts[0] as string;
      fraction = last;
    }
  } else {
    integerPart = s;
  }

  if (!/^\d+$/.test(integerPart)) return null;
  if (fraction !== "" && !/^\d{1,2}$/.test(fraction)) return null;
  const cents = Number(integerPart) * 100 + Number(fraction.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}
