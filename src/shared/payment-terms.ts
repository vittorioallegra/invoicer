import { z } from "zod";

/**
 * Payment terms: a number of days (0-365) counted from a basis. `invoice_date` is "data fattura"
 * (DF); `end_of_month` is "fine mese data fattura" (FM DF): the due date is moved to the last day
 * of the month in which the days run out ("30 gg FM DF": issued 2026-11-10 -> 2026-12-10 -> due
 * 2026-12-31). `extraDays` (0-31, only with `end_of_month`) are added after that end of month
 * ("fine mese + 5 gg": issued 2026-11-10, 0 days -> 2026-11-30 -> due 2026-12-05). Dates are plain
 * `YYYY-MM-DD` strings on the Europe/Rome calendar, so no time zone arithmetic is involved.
 */

export const PAYMENT_TERMS_BASES = ["invoice_date", "end_of_month"] as const;
export type PaymentTermsBasis = (typeof PAYMENT_TERMS_BASES)[number];

export const PAYMENT_TERMS_MAX_DAYS = 365;
export const PAYMENT_TERMS_MAX_EXTRA_DAYS = 31;

export const paymentTermsSchema = z
  .object({
    days: z.number().int().min(0).max(PAYMENT_TERMS_MAX_DAYS),
    basis: z.enum(PAYMENT_TERMS_BASES),
    extraDays: z.number().int().min(0).max(PAYMENT_TERMS_MAX_EXTRA_DAYS).default(0),
  })
  .transform((terms) => (terms.basis === "invoice_date" ? { ...terms, extraDays: 0 } : terms));
export type PaymentTerms = z.output<typeof paymentTermsSchema>;

const DAY_MS = 86_400_000;
const toDate = (value: string) => new Date(`${value}T00:00:00Z`);
const toText = (date: Date) => date.toISOString().slice(0, 10);

/** Last day of the month of a `YYYY-MM-DD` date (February and leap years included). */
export function endOfMonth(date: string): string {
  const parsed = toDate(date);
  return toText(new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)));
}

const addDays = (date: string, days: number) =>
  toText(new Date(toDate(date).getTime() + days * DAY_MS));

/**
 * The due date for an issue date: days after it; for `end_of_month` then the end of that month
 * plus the extra days.
 */
export function dueDate(issueDate: string, terms: PaymentTerms): string {
  const due = addDays(issueDate, terms.days);
  return terms.basis === "end_of_month" ? addDays(endOfMonth(due), terms.extraDays) : due;
}

/** FatturaPA `DataRiferimentoTerminiPagamento`: the invoice date, or the end of its month. */
export function termsReferenceDate(issueDate: string, terms: PaymentTerms): string {
  return terms.basis === "end_of_month" ? endOfMonth(issueDate) : issueDate;
}

/** Maps the old plain "days" client default to terms counted from the invoice date. */
export function legacyTerms(days: number): PaymentTerms {
  return {
    days: Math.min(PAYMENT_TERMS_MAX_DAYS, Math.max(0, Math.round(days))),
    basis: "invoice_date",
    extraDays: 0,
  };
}
