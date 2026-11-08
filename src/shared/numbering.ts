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

/**
 * The number as shown to people: the printed number and its numbering year, e.g. `FA-1/2026`.
 * Used in every UI text, email, notification and PDF; the FatturaPA XML `Numero` and file name
 * keep the bare printed number. Without a year (not numbered yet) it is the number alone.
 */
export function formatNumberWithYear(number: string, year: number | null | undefined): string {
  return year === null || year === undefined ? number : `${number}/${year}`;
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

/** The request body for creating a series: the endpoint takes text, not the nulls of the parsed value. */
export const seriesRequestBody = (series: NumberingSeriesData): NumberingSeriesInput => ({
  name: series.name,
  prefix: series.prefix ?? "",
  suffix: series.suffix ?? "",
});

export interface NumberingSeriesRecord extends SeriesAffixes {
  id: string;
  name: string;
  isDefault: boolean;
}

/**
 * The progressive of a printed number in one series: the digits between its prefix and suffix
 * (at most 9), or null when the number is not exactly prefix + digits + suffix.
 */
export function progressiveIn(raw: string, series: SeriesAffixes): number | null {
  const prefix = series.prefix ?? "";
  const suffix = series.suffix ?? "";
  if (raw.length <= prefix.length + suffix.length) return null;
  if (!raw.startsWith(prefix) || !raw.endsWith(suffix)) return null;
  const middle = raw.slice(prefix.length, raw.length - suffix.length);
  return /^\d{1,9}$/.test(middle) ? Number(middle) : null;
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
  for (const s of series.filter((s) => s.prefix || s.suffix)) {
    const progressive = progressiveIn(raw, s);
    if (progressive !== null) return { seriesId: s.id, progressive };
  }
  return { seriesId: fallback, progressive: /^\d{1,9}$/.test(raw) ? Number(raw) : null };
}

/**
 * The series and progressive of a number the owner typed for an imported invoice, who may also
 * have picked a series: that series wins when the number fits it (or when the number is free text
 * with no progressive anywhere); otherwise the number decides, as on import.
 */
export function resolveImportedNumber(
  raw: string,
  chosenId: string | null,
  series: readonly Pick<NumberingSeriesRecord, "id" | "prefix" | "suffix" | "isDefault">[],
): { seriesId: string | null; progressive: number | null } {
  const chosen = series.find((s) => s.id === chosenId);
  if (chosen) {
    const progressive = progressiveIn(raw, chosen);
    if (progressive !== null) return { seriesId: chosen.id, progressive };
  }
  const matched = matchSeries(raw, series);
  return chosen && matched.progressive === null
    ? { seriesId: chosen.id, progressive: null }
    : matched;
}
