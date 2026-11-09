import type { InvoiceFilters } from "../../shared/invoice-filters";
import type { ReceivedFilters } from "../../shared/received-filters";

/**
 * The filters the Invoices list had when the owner last looked at it, so that the "back" link of
 * an invoice page returns to the same filtered list instead of the unfiltered one. Kept for the
 * life of the tab (`sessionStorage`), in memory when that is not available.
 */
const KEY = "invoicer.invoiceFilters";

let remembered: InvoiceFilters | null = null;

export function rememberInvoiceFilters(filters: InvoiceFilters): void {
  remembered = filters;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(filters));
  } catch {
    // Storage blocked: the in-memory copy still works for this page load.
  }
}

export function rememberedInvoiceFilters(): InvoiceFilters {
  if (remembered) return remembered;
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (parsed && typeof parsed === "object") return parsed as InvoiceFilters;
    }
  } catch {
    // Unreadable: start from no filters.
  }
  return {} as InvoiceFilters;
}

const RECEIVED_KEY = "invoicer.receivedFilters";
let rememberedReceived: ReceivedFilters | null = null;

/** Same for the Received list. */
export function rememberReceivedFilters(filters: ReceivedFilters): void {
  rememberedReceived = filters;
  try {
    sessionStorage.setItem(RECEIVED_KEY, JSON.stringify(filters));
  } catch {
    // Storage blocked: the in-memory copy still works for this page load.
  }
}

export function rememberedReceivedFilters(): ReceivedFilters {
  if (rememberedReceived) return rememberedReceived;
  try {
    const stored = sessionStorage.getItem(RECEIVED_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (parsed && typeof parsed === "object") return parsed as ReceivedFilters;
    }
  } catch {
    // Unreadable: start from no filters.
  }
  return {};
}
