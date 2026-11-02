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
