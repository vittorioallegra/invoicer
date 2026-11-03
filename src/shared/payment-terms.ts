import { z } from "zod";

/**
 * Payment terms, one choice of five. `invoice_date` ("data fattura"): due on the issue date.
 * `eom_15`: the end of the invoice month plus 15 days ("15 gg fine mese data fattura", issued
 * 2026-11-10 -> due 2026-12-15). `eom_30` and `eom_60`: the last day of the first / second month
 * after the invoice month, month-based and not day-based (2026-11-10 -> 2026-12-31 / 2027-01-31).
 * `custom`: 0-365 days added to the invoice date. Dates are plain `YYYY-MM-DD` strings on the
 * Europe/Rome calendar, so no time zone arithmetic is involved.
 */

export const PAYMENT_TERMS_KINDS = [
  "invoice_date",
  "eom_15",
  "eom_30",
  "eom_60",
  "custom",
] as const;
export type PaymentTermsKind = (typeof PAYMENT_TERMS_KINDS)[number];

export const PAYMENT_TERMS_MAX_DAYS = 365;

const currentTermsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("invoice_date") }),
  z.object({ kind: z.literal("eom_15") }),
  z.object({ kind: z.literal("eom_30") }),
  z.object({ kind: z.literal("eom_60") }),
  z.object({
    kind: z.literal("custom"),
    days: z.number().int().min(0).max(PAYMENT_TERMS_MAX_DAYS),
  }),
]);
export type PaymentTerms = z.output<typeof currentTermsSchema>;

const clampDays = (days: number) => Math.min(PAYMENT_TERMS_MAX_DAYS, Math.max(0, Math.round(days)));

/** Days counted from the invoice date: 0 is the invoice date itself. */
function daysFromInvoiceDate(days: number): PaymentTerms {
  const whole = clampDays(days);
  return whole === 0 ? { kind: "invoice_date" } : { kind: "custom", days: whole };
}

/**
 * Older stored shapes: a plain number of days, `{ days, basis, extraDays }`. Anything else is
 * passed through for the current schema to accept or reject.
 */
function upgradeLegacy(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) return daysFromInvoiceDate(value);
  if (typeof value !== "object" || value === null || !("basis" in value) || "kind" in value) {
    return value;
  }
  const { days, basis, extraDays } = value as {
    days?: unknown;
    basis?: unknown;
    extraDays?: unknown;
  };
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0) return value;
  if (days > PAYMENT_TERMS_MAX_DAYS) return value;
  const extra = typeof extraDays === "number" && Number.isInteger(extraDays) ? extraDays : 0;
  if (extra < 0 || extra > 31) return value;
  if (basis === "invoice_date") return daysFromInvoiceDate(days);
  if (basis !== "end_of_month") return value;
  if (days === 0 && extra === 15) return { kind: "eom_15" };
  if (days === 30 && extra === 0) return { kind: "eom_30" };
  if (days === 60 && extra === 0) return { kind: "eom_60" };
  return { kind: "custom", days: clampDays(days + extra) };
}

export const paymentTermsSchema = z.preprocess(upgradeLegacy, currentTermsSchema);

const DAY_MS = 86_400_000;
const toDate = (value: string) => new Date(`${value}T00:00:00Z`);
const toText = (date: Date) => date.toISOString().slice(0, 10);

/** Last day of the month `monthsAfter` months after the month of a `YYYY-MM-DD` date. */
function endOfMonth(date: string, monthsAfter = 0): string {
  const parsed = toDate(date);
  return toText(
    new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + monthsAfter + 1, 0)),
  );
}

const addDays = (date: string, days: number) =>
  toText(new Date(toDate(date).getTime() + days * DAY_MS));

/** The due date for an issue date. */
export function dueDate(issueDate: string, terms: PaymentTerms): string {
  switch (terms.kind) {
    case "invoice_date":
      return issueDate;
    case "eom_15":
      return addDays(endOfMonth(issueDate), 15);
    case "eom_30":
      return endOfMonth(issueDate, 1);
    case "eom_60":
      return endOfMonth(issueDate, 2);
    case "custom":
      return addDays(issueDate, terms.days);
  }
}

/** Maps the old plain "days" client default to terms counted from the invoice date. */
export function legacyTerms(days: number): PaymentTerms {
  return daysFromInvoiceDate(days);
}
