import type { ReceivedDocument, ReceivedInvoice } from "../../shared/fatturapa";
import { decimalToCents, type ReceivedSummary } from "../../shared/import";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The document total in cents: `ImportoTotaleDocumento`, else the VAT summary's sum. */
export function documentTotalCents(document: ReceivedDocument): number | null {
  if (document.total !== null) return decimalToCents(document.total);
  if (document.vatSummary.length === 0) return null;
  let sum = 0;
  for (const row of document.vatSummary) {
    const taxable = decimalToCents(row.taxable);
    const vat = decimalToCents(row.vat);
    if (taxable === null || vat === null) return null;
    sum += taxable + vat;
  }
  return sum;
}

/** The VAT id with its country, else the codice fiscale, as the lists show it. */
export function vatIdOf(party: ReceivedInvoice["supplier"]): string | null {
  if (party.vatId) return `${party.vatId.country}${party.vatId.code}`;
  return party.taxCode;
}

/** What the lists show of an invoice file (its first document); null when it lacks the basics. */
export function summarizeInvoice(invoice: ReceivedInvoice): ReceivedSummary | null {
  const document = invoice.documents[0];
  if (!document) return null;
  const name = invoice.supplier.name.trim();
  if (name === "" || document.number === "" || !DATE_ONLY.test(document.date)) return null;
  return {
    supplierName: name,
    supplierVat: vatIdOf(invoice.supplier),
    number: document.number,
    issueDate: document.date,
    documentType: document.documentType || "TD01",
    currency: /^[A-Z]{3}$/.test(document.currency) ? document.currency : "EUR",
    totalCents: documentTotalCents(document),
  };
}
