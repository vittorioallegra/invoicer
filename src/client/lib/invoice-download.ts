import type { ClientRecord } from "../../shared/client";
import { romeDateTime } from "../../shared/cron";
import { buildFatturaXml } from "../../shared/fatturapa";
import type { InvoiceRecord } from "../../shared/invoice";
import { type PdfIdentity, renderInvoicePdfFor } from "../pdf/generate";
import { api } from "./api";
import { fatturaInput, provisionalNumberFor, SendFlowError } from "./send-flow";
import type { ProfileResponse } from "./settings-api";
import { checkFatturaXml } from "./xsd";

/**
 * Number and date an invoice prints before it is sent: the reserved ones when it has them, else
 * the number it would get now and its invoice date (today when empty or in the future, as the
 * Worker does when it reserves the number).
 */
async function identityOf(invoice: InvoiceRecord): Promise<PdfIdentity> {
  if (invoice.number && invoice.issueDate) {
    return { number: invoice.number, issueDate: invoice.issueDate };
  }
  const today = romeDateTime(new Date()).date;
  const date = invoice.invoiceDate && invoice.invoiceDate <= today ? invoice.invoiceDate : today;
  return {
    number: invoice.number ?? (await provisionalNumberFor(invoice, today)),
    issueDate: date,
  };
}

/** The PDF of an invoice that is not sent yet, with a provisional number when it has none. */
export async function renderUnsentPdf(invoiceId: string): Promise<Uint8Array> {
  const { invoice } = await api<{ invoice: InvoiceRecord }>(`/api/invoices/${invoiceId}`);
  return renderInvoicePdfFor(invoiceId, await identityOf(invoice));
}

/**
 * The FatturaPA XML of an invoice that is not sent yet, checked against the XSD. Throws a
 * `SendFlowError` (`invalid_xml`) when the schema refuses it.
 */
export async function buildUnsentXml(
  invoiceId: string,
): Promise<{ fileName: string; xml: string }> {
  const [{ invoice }, { clients }, { profile }] = await Promise.all([
    api<{ invoice: InvoiceRecord }>(`/api/invoices/${invoiceId}`),
    api<{ clients: ClientRecord[] }>("/api/clients"),
    api<{ profile: ProfileResponse | null }>("/api/profile"),
  ]);
  const client = clients.find((c) => c.id === invoice.clientId);
  if (!client || !profile) throw new SendFlowError("missing_data");
  const { number, issueDate } = await identityOf(invoice);
  const built = buildFatturaXml(fatturaInput(invoice, client, profile, number, issueDate, 0));
  const check = await checkFatturaXml(built.xml);
  if (!check.valid) throw new SendFlowError("invalid_xml", { mapped: check.mapped });
  return { fileName: built.fileName, xml: built.xml };
}

/** Saves bytes or text as a file through a temporary link (works without a popup). */
export function saveFile(content: Uint8Array | string, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started by the time the task ends; free the object URL afterwards.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Downloads a file the Worker serves as an attachment. */
export function downloadUrl(href: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}
