/**
 * FatturaPA file naming: `<IdPaese><IdCodice>_<progressive>.xml`. The progressive is a
 * case-insensitive alphanumeric string of at most 5 characters in the SdI naming rules; we use
 * 5 upper-case base-36 digits, counted by `file_sequence` (one new value per transmission attempt,
 * so a resend after a rejection keeps number and date but never the file name).
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const FILE_PROGRESSIVE_LENGTH = 5;
/** Largest progressive that fits 5 base-36 digits. */
export const FILE_PROGRESSIVE_MAX = 36 ** FILE_PROGRESSIVE_LENGTH - 1;

/** Encodes a counter value as 5 upper-case base-36 digits (`1` -> `00001`, `36` -> `00010`). */
export function encodeFileProgressive(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > FILE_PROGRESSIVE_MAX) {
    throw new RangeError(`File progressive out of range: ${value}`);
  }
  let rest = value;
  let out = "";
  for (let i = 0; i < FILE_PROGRESSIVE_LENGTH; i++) {
    out = DIGITS[rest % 36] + out;
    rest = Math.floor(rest / 36);
  }
  return out;
}

/** Inverse of `encodeFileProgressive`; null when the text is not a valid progressive. */
export function decodeFileProgressive(text: string): number | null {
  if (!/^[0-9A-Z]{5}$/.test(text)) return null;
  return [...text].reduce((sum, char) => sum * 36 + DIGITS.indexOf(char), 0);
}

/** `IT01234567890_0000A.xml` for the issuer's id and a counter value. */
export function fatturaFileName(idPaese: string, idCodice: string, progressive: number): string {
  return `${idPaese}${idCodice}_${encodeFileProgressive(progressive)}.xml`;
}

/**
 * SQLite expression that renders an integer expression as the same 5 base-36 digits, so the
 * Worker can name a transmission inside the guarded D1 batch (no read-modify-write).
 */
export function fileProgressiveSql(valueSql: string): string {
  const digits = `'${DIGITS}'`;
  const digit = (power: number) =>
    `substr(${digits}, ((${valueSql}) / ${36 ** power}) % 36 + 1, 1)`;
  return [4, 3, 2, 1, 0].map(digit).join(" || ");
}
