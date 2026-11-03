import { z } from "zod";

/**
 * Payment terms: a number of days counted from a basis. `invoice_date` is "data fattura" (DF);
 * `end_of_month` is "fine mese data fattura" (FM DF): the due date is moved to the last day of
 * the month in which the days run out ("30 gg FM DF": issued 2026-11-10 -> 2026-12-10 -> due
 * 2026-12-31). Dates are plain `YYYY-MM-DD` strings on the Europe/Rome calendar, so no time
 * zone arithmetic is involved.
 */

export const PAYMENT_TERMS_DAYS = [0, 30, 60, 90, 120] as const;
export type PaymentTermsDays = (typeof PAYMENT_TERMS_DAYS)[number];

export const PAYMENT_TERMS_BASES = ["invoice_date", "end_of_month"] as const;
export type PaymentTermsBasis = (typeof PAYMENT_TERMS_BASES)[number];

export const paymentTermsSchema = z.object({
  days: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(90), z.literal(120)]),
  basis: z.enum(PAYMENT_TERMS_BASES),
});
export type PaymentTerms = z.output<typeof paymentTermsSchema>;

const DAY_MS = 86_400_000;
const toDate = (value: string) => new Date(`${value}T00:00:00Z`);
const toText = (date: Date) => date.toISOString().slice(0, 10);

/** Last day of the month of a `YYYY-MM-DD` date (February and leap years included). */
export function endOfMonth(date: string): string {
  const parsed = toDate(date);
  return toText(new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)));
}

/** The due date for an issue date: days after it, then the end of that month for `end_of_month`. */
export function dueDate(issueDate: string, terms: PaymentTerms): string {
  const due = toText(new Date(toDate(issueDate).getTime() + terms.days * DAY_MS));
  return terms.basis === "end_of_month" ? endOfMonth(due) : due;
}

/** FatturaPA `DataRiferimentoTerminiPagamento`: the invoice date, or the end of its month. */
export function termsReferenceDate(issueDate: string, terms: PaymentTerms): string {
  return terms.basis === "end_of_month" ? endOfMonth(issueDate) : issueDate;
}

/** The allowed number of days closest to `days` (the older free-form default maps to it). */
export function nearestTermsDays(days: number): PaymentTermsDays {
  let best: PaymentTermsDays = PAYMENT_TERMS_DAYS[0];
  for (const candidate of PAYMENT_TERMS_DAYS) {
    if (Math.abs(candidate - days) < Math.abs(best - days)) best = candidate;
  }
  return best;
}

/** Maps the old plain "days" client default to terms counted from the invoice date. */
export function legacyTerms(days: number): PaymentTerms {
  return { days: nearestTermsDays(days), basis: "invoice_date" };
}
