import { z } from "zod";
import type { InvoiceSummary } from "./invoice";

/**
 * Filters of the Invoices page. They live in the URL search params and in the query string of
 * `GET /api/invoices?scope=all`, so one schema serves both.
 */
export const INVOICE_STATUS_FILTERS = [
  "to_send",
  "in_progress",
  "delivered",
  "rejected",
  "paid",
  "unpaid",
  "overdue",
] as const;
export type InvoiceStatusFilter = (typeof INVOICE_STATUS_FILTERS)[number];

/** Invoice states behind each status filter (`paid`/`unpaid` also look at the payment flag). */
export const STATUS_FILTER_STATES: Record<InvoiceStatusFilter, readonly string[]> = {
  to_send: ["draft", "planned"],
  in_progress: ["sending", "sent"],
  // "Not delivered" (the SdI could not reach the client) is delivered to the client's AdE area.
  delivered: ["delivered", "not_delivered"],
  rejected: ["rejected", "rejected_expired"],
  paid: ["sending", "sent", "delivered", "not_delivered"],
  unpaid: ["sending", "sent", "delivered", "not_delivered"],
  overdue: ["sending", "sent", "delivered", "not_delivered"],
};

/** The year filter is a four-digit year or `all`; absent means the current Europe/Rome year. */
export const invoiceFiltersSchema = z.object({
  year: z.union([z.literal("all"), z.string().regex(/^\d{4}$/)]).optional(),
  status: z.enum(INVOICE_STATUS_FILTERS).optional(),
  client: z.string().min(1).max(100).optional(),
  series: z.string().min(1).max(100).optional(),
});
export type InvoiceFilters = z.infer<typeof invoiceFiltersSchema>;

/** Totals of the filtered set in one currency, in integer cents (credit notes subtracted). */
export interface CurrencyRecap {
  currency: string;
  /** Finalised invoices, rejected ones excluded. */
  invoicedCents: number;
  /** VAT inside `invoicedCents`. */
  vatCents: number;
  /** Cassa/rivalsa contribution inside `invoicedCents` (before VAT). */
  contributionCents: number;
  /** Finalised, not rejected, not paid. */
  toCollectCents: number;
  /** Invoices not sent yet. */
  toSendCents: number;
}

export interface InvoiceRecap {
  count: number;
  toSendCount: number;
  /** Finalised invoices not paid (the ones `toCollectCents` adds up). */
  toCollectCount: number;
  /** Finalised invoices whose VAT is unknown (imported without it): counted as VAT 0. */
  unknownVatCount: number;
  /** One entry per currency present in the set; EUR is always listed first. */
  byCurrency: CurrencyRecap[];
}

export interface InvoiceOverview {
  invoices: InvoiceSummary[];
  recap: InvoiceRecap;
  /** Years that have an invoice (the current one always), newest first. */
  years: number[];
}

/** Invoiced total of a period in one currency: finalised invoices, credit notes subtracted. */
export interface PeriodTotal {
  currency: string;
  /** Gross total (taxable amount, contribution and VAT). */
  invoicedCents: number;
  /** VAT inside `invoicedCents`; invoices without lines (imported) count as 0. */
  vatCents: number;
  /** Cassa/rivalsa contribution inside `invoicedCents`. */
  contributionCents: number;
}

/** One calendar month of the trend chart (EUR only): this year against the previous one. */
export interface MonthlyPoint {
  /** 1 to 12. */
  month: number;
  currentCents: number;
  previousCents: number;
}

export interface ClientShare {
  name: string;
  invoicedCents: number;
}

/** Home overview (`GET /api/invoices/dashboard`). */
export interface DashboardStats {
  /** Europe/Rome today, `YYYY-MM-DD`: the year and month below are its. */
  today: string;
  /** Invoices not sent yet. */
  toSendCount: number;
  /** Rejected invoices (including those whose resend window expired). */
  rejectedCount: number;
  /** Finalised invoices, not paid, past their due date (credit notes excluded). */
  overdueCount: number;
  /** Invoiced in the current year; EUR is always listed first. */
  year: PeriodTotal[];
  /** Finalised invoices dated in the current year that have no lines: VAT counted as 0. */
  unknownVatCount: number;
  /** Finalised, unpaid, all years, EUR. */
  toCollectCents: number;
  toCollectCount: number;
  /** Twelve months, EUR. */
  monthly: MonthlyPoint[];
  /** Every client with EUR invoiced this year, the biggest first. */
  clientShares: ClientShare[];
}
