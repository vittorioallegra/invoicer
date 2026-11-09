import { z } from "zod";
import { compareClientNames } from "./client";
import type { ReceivedInvoiceRecord } from "./received";

/**
 * Filters of the Received page, kept in the URL search params like those of the Invoices page. The
 * year is a four-digit year or `all` (absent: all years, unlike the Invoices page, so that an
 * invoice dated in December that arrives in January is never hidden); the sender is the key of a
 * supplier (`supplierKey`).
 */
export const receivedFiltersSchema = z.object({
  year: z.union([z.literal("all"), z.string().regex(/^\d{4}$/)]).optional(),
  supplier: z.string().min(1).max(200).optional(),
});
export type ReceivedFilters = z.infer<typeof receivedFiltersSchema>;

/** What identifies a supplier: its VAT number, else its name without case. Null before it was read. */
export function supplierKey(record: ReceivedInvoiceRecord): string | null {
  if (record.parseStatus !== "parsed") return null;
  const vat = record.supplierVat?.trim();
  if (vat) return vat.toUpperCase();
  const name = record.supplierName?.trim().toLowerCase();
  return name || null;
}

const yearOf = (record: ReceivedInvoiceRecord): number | null =>
  record.issueDate ? Number(record.issueDate.slice(0, 4)) : null;

/**
 * The invoices a set of filters keeps. An invoice with no date yet (still being read, or unreadable)
 * is kept by every year, because it would otherwise vanish until it is read; a sender filter keeps
 * only invoices already read.
 */
export function filterReceived(
  records: readonly ReceivedInvoiceRecord[],
  filters: ReceivedFilters,
): ReceivedInvoiceRecord[] {
  const year = filters.year ?? "all";
  return records.filter((record) => {
    const recordYear = yearOf(record);
    if (year !== "all" && recordYear !== null && String(recordYear) !== year) return false;
    if (filters.supplier && supplierKey(record) !== filters.supplier) return false;
    return true;
  });
}

/** The years that have an invoice, newest first; the current one is always listed. */
export function receivedYears(
  records: readonly ReceivedInvoiceRecord[],
  currentYear: string,
): number[] {
  const years = new Set<number>([Number(currentYear)]);
  for (const record of records) {
    const year = yearOf(record);
    if (year !== null) years.add(year);
  }
  return [...years].sort((a, b) => b - a);
}

export interface ReceivedSupplier {
  key: string;
  name: string;
}

/** The suppliers that sent an invoice, by name. */
export function receivedSuppliers(records: readonly ReceivedInvoiceRecord[]): ReceivedSupplier[] {
  const found = new Map<string, string>();
  for (const record of records) {
    const key = supplierKey(record);
    if (key && !found.has(key)) found.set(key, record.supplierName?.trim() || key);
  }
  return [...found]
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => compareClientNames(a.name, b.name));
}

export interface ReceivedCurrencyRecap {
  currency: string;
  /** All read invoices of the set, credit notes subtracted. */
  receivedCents: number;
  /** The ones not paid yet, credit notes subtracted. */
  toPayCents: number;
}

export interface ReceivedRecap {
  count: number;
  /** One entry per currency, EUR first. */
  byCurrency: ReceivedCurrencyRecap[];
}

/** Totals of a set of received invoices. Only invoices that were read, with a total, are summed. */
export function receivedRecap(records: readonly ReceivedInvoiceRecord[]): ReceivedRecap {
  const totals = new Map<string, ReceivedCurrencyRecap>();
  for (const record of records) {
    if (record.parseStatus !== "parsed" || record.totalCents === null) continue;
    const credit = record.documentType === "TD04";
    const cents = credit ? -record.totalCents : record.totalCents;
    const row = totals.get(record.currency) ?? {
      currency: record.currency,
      receivedCents: 0,
      toPayCents: 0,
    };
    row.receivedCents += cents;
    if (credit || record.paymentFlag !== "paid") row.toPayCents += cents;
    totals.set(record.currency, row);
  }
  const byCurrency = [...totals.values()].sort(
    (a, b) =>
      Number(b.currency === "EUR") - Number(a.currency === "EUR") ||
      a.currency.localeCompare(b.currency),
  );
  if (byCurrency.length === 0)
    byCurrency.push({ currency: "EUR", receivedCents: 0, toPayCents: 0 });
  return { count: records.length, byCurrency };
}
