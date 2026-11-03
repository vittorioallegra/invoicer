import { z } from "zod";

/**
 * Numbering series (sezionali). The printed invoice number (FatturaPA `Numero`) is
 * prefix + progressive + suffix. `Numero` is at most 20 basic Latin characters (XSD
 * `String20Type`); the progressive has at most 9 digits (`MAX_INVOICE_NUMBER`), so a series
 * may use at most 11 characters between prefix and suffix. See docs/notes/invoice-numbering.md.
 */
export const MAX_NUMBER_LENGTH = 20;
const MAX_PROGRESSIVE_DIGITS = 9;
export const MAX_AFFIX_LENGTH = MAX_NUMBER_LENGTH - MAX_PROGRESSIVE_DIGITS;

/** Basic Latin letters and digits plus `-`, `/` and `.`. */
const AFFIX_PATTERN = /^[A-Za-z0-9\-/.]*$/;

export interface SeriesAffixes {
  prefix: string | null;
  suffix: string | null;
}

/** The printed number of a progressive in a series: prefix + progressive + suffix. */
export function formatInvoiceNumber(series: SeriesAffixes, progressive: number): string {
  return `${series.prefix ?? ""}${progressive}${series.suffix ?? ""}`;
}

const text = (max: number) => z.string().trim().max(max);

/** Optional prefix or suffix: empty means none. Messages are stable codes for the UI. */
const affix = z
  .string()
  .trim()
  .max(MAX_AFFIX_LENGTH, "affix_too_long")
  .refine((value) => AFFIX_PATTERN.test(value), "invalid_affix")
  .transform((value) => value || null);

/** A numbering series as the owner submits it. */
export const numberingSeriesInputSchema = z
  .object({
    name: text(40).min(1, "required"),
    prefix: affix.default(""),
    suffix: affix.default(""),
  })
  .superRefine((series, ctx) => {
    if ((series.prefix?.length ?? 0) + (series.suffix?.length ?? 0) > MAX_AFFIX_LENGTH) {
      ctx.addIssue({ code: "custom", path: ["suffix"], message: "affix_too_long" });
    }
  });
export type NumberingSeriesInput = z.input<typeof numberingSeriesInputSchema>;
export type NumberingSeriesData = z.output<typeof numberingSeriesInputSchema>;

export interface NumberingSeriesRecord extends SeriesAffixes {
  id: string;
  name: string;
  isDefault: boolean;
}

/**
 * The series an already printed number belongs to, for invoices imported from elsewhere: a series
 * that has a prefix or a suffix when the number is exactly prefix + digits + suffix, else the
 * default series. Returns the series id and the progressive (null when the number has no clean
 * progressive, e.g. free text), which keeps imported numbers from blocking another series.
 */
export function matchSeries(
  raw: string,
  series: readonly Pick<NumberingSeriesRecord, "id" | "prefix" | "suffix" | "isDefault">[],
): { seriesId: string | null; progressive: number | null } {
  const fallback = series.find((s) => s.isDefault)?.id ?? null;
  const candidates = series.filter((s) => s.prefix || s.suffix);
  for (const s of candidates) {
    const prefix = s.prefix ?? "";
    const suffix = s.suffix ?? "";
    if (raw.length <= prefix.length + suffix.length) continue;
    if (!raw.startsWith(prefix) || !raw.endsWith(suffix)) continue;
    const middle = raw.slice(prefix.length, raw.length - suffix.length);
    if (/^\d{1,9}$/.test(middle)) return { seriesId: s.id, progressive: Number(middle) };
  }
  return { seriesId: fallback, progressive: /^\d{1,9}$/.test(raw) ? Number(raw) : null };
}
