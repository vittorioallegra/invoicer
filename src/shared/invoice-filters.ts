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
  /** Finalised invoices without the VAT (the cassa/rivalsa contribution stays in, it is paid). */
  netInvoicedCents: number;
  /** VAT of the finalised invoices. */
  vatCents: number;
  /** Cassa/rivalsa contribution of the finalised invoices (already inside the net total). */
  contributionCents: number;
  /** Finalised, not rejected, not paid. */
  toCollectCents: number;
  /** Invoices not sent yet. */
  toSendCents: number;
}

export interface InvoiceRecap {
  count: number;
  toSendCount: number;
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
  invoicedCents: number;
}

/** Home top strip (`GET /api/invoices/dashboard`). */
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
  /** Invoiced in the current month; EUR is always listed first. */
  month: PeriodTotal[];
}
