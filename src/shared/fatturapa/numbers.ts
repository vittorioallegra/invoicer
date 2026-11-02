/** Decimal formatting for the XSD number patterns (`[0-9]{1,11}\.[0-9]{2,8}` and the like). */

const pad = (value: bigint | number, width: number) => String(value).padStart(width, "0");

/** Integer cents as `1234.56` (always two decimals, `-` for negatives). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${pad(abs % 100, 2)}`;
}

/** Basis points as a percentage with two decimals: `2200` -> `22.00`. */
export function formatBasisPoints(bp: number): string {
  return `${Math.floor(bp / 100)}.${pad(bp % 100, 2)}`;
}

/** Quantity in thousandths as `7.50`, `1.00` or `0.125` (at least two decimals). */
export function formatQuantity(milli: number): string {
  return trimDecimals(`${Math.floor(milli / 1000)}.${pad(milli % 1000, 3)}`);
}

/** Keeps at least two decimals and drops trailing zeros beyond them. */
export function trimDecimals(text: string): string {
  const [whole = "0", fraction = ""] = text.split(".");
  let end = fraction.length;
  while (end > 2 && fraction[end - 1] === "0") end--;
  return `${whole}.${fraction.slice(0, end).padEnd(2, "0")}`;
}

/** Half-up integer division for non-negative BigInts. */
export function divRoundBig(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

/**
 * Price per unit in euro with up to 8 decimals, from an amount in cents and a quantity in
 * thousandths: `amount / quantity` computed exactly in integers and rounded half up.
 */
export function formatUnitPrice(amountCents: number, quantityMilli: number): string {
  const negative = amountCents < 0;
  const scaled = divRoundBig(BigInt(Math.abs(amountCents)) * 1_000_000_000n, BigInt(quantityMilli));
  const whole = scaled / 100_000_000n;
  const fraction = pad(scaled % 100_000_000n, 8);
  return `${negative ? "-" : ""}${trimDecimals(`${whole}.${fraction}`)}`;
}

/** An exchange rate as an exact integer ratio: `units` of foreign currency per 1 EUR. */
export interface ExchangeRate {
  /** Rate multiplied by `10 ** scale`. */
  scaled: bigint;
  scale: number;
  /** The rate as written in the XML (`1.0850`). */
  text: string;
}

/** Parses `1.0850` or `1,0850` (positive, at most 8 decimals); null when invalid. */
export function parseExchangeRate(input: string): ExchangeRate | null {
  const text = input.trim().replace(",", ".");
  const match = /^(\d{1,9})(?:\.(\d{1,8}))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  const scaled = BigInt(`${match[1]}${fraction}`);
  if (scaled === 0n) return null;
  return { scaled, scale: fraction.length, text: trimDecimals(`${match[1]}.${fraction}`) };
}

/** Converts cents of the foreign currency to euro cents (`foreign = EUR x rate`), half up. */
export function convertToEurCents(foreignCents: number, rate: ExchangeRate): number {
  const negative = foreignCents < 0;
  const eur = divRoundBig(BigInt(Math.abs(foreignCents)) * 10n ** BigInt(rate.scale), rate.scaled);
  return Number(eur) * (negative ? -1 : 1);
}
