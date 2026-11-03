import type { ClientRecord } from "../../shared/client";
import type { FatturaIssuer } from "../../shared/fatturapa";
import { type InvoiceRecord, invoiceLanguage } from "../../shared/invoice";
import { api } from "../lib/api";
import type { ProfileResponse } from "../lib/settings-api";
import type { InvoicePdfInput } from "./invoice-model";

export type PdfPreparationError = "not_numbered" | "no_client" | "no_profile";

export class PdfError extends Error {
  constructor(readonly code: PdfPreparationError) {
    super(code);
    this.name = "PdfError";
  }
}

export interface StoredPdf {
  id: string;
  filename: string;
  size: number;
  sha256: string;
  transmissionId: string;
  attempt: number;
}

/** The number and date a PDF prints when the invoice does not hold them yet (a provisional copy). */
export interface PdfIdentity {
  number: string;
  issueDate: string;
}

/** Loads what the PDF prints for an invoice that holds its number, or the given identity. */
export async function loadInvoicePdfInput(
  invoiceId: string,
  identity?: PdfIdentity,
): Promise<InvoicePdfInput> {
  const [{ invoice }, { clients }, { profile }] = await Promise.all([
    api<{ invoice: InvoiceRecord }>(`/api/invoices/${invoiceId}`),
    api<{ clients: ClientRecord[] }>("/api/clients"),
    api<{ profile: ProfileResponse | null }>("/api/profile"),
  ]);
  const number = identity?.number ?? invoice.number;
  const issueDate = identity?.issueDate ?? invoice.issueDate;
  if (!number || !issueDate) throw new PdfError("not_numbered");
  const client = clients.find((c) => c.id === invoice.clientId);
  if (!client) throw new PdfError("no_client");
  if (!profile) throw new PdfError("no_profile");
  return {
    issuer: {
      name: profile.name,
      vatNumber: profile.vatNumber,
      taxCode: profile.taxCode,
      address: profile.address ?? "",
      postalCode: profile.postalCode ?? "",
      city: profile.city ?? "",
      province: profile.province,
      country: profile.country,
      email: profile.email,
      phone: profile.phone,
      regimeFiscale: profile.regimeFiscale as FatturaIssuer["regimeFiscale"],
    },
    client,
    invoice,
    number,
    issueDate,
    linked:
      invoice.linked?.number && invoice.linked.issueDate
        ? { number: invoice.linked.number, issueDate: invoice.linked.issueDate }
        : null,
    language: invoiceLanguage(invoice.data, client),
  };
}

/**
 * Renders the PDF of a reserved or issued invoice, or of an unnumbered one with a provisional
 * identity, for download only (nothing is stored).
 */
export async function renderInvoicePdfFor(
  invoiceId: string,
  identity?: PdfIdentity,
): Promise<Uint8Array> {
  const { renderInvoicePdf } = await import("./render");
  return renderInvoicePdf(await loadInvoicePdfInput(invoiceId, identity));
}

/**
 * Renders the invoice PDF and stores it for the invoice's current transmission attempt. The send
 * flow (step 12) calls this right after the number is reserved, and again for every resend.
 */
export async function generateAndStoreInvoicePdf(invoiceId: string): Promise<StoredPdf> {
  const bytes = await renderInvoicePdfFor(invoiceId);
  const { file } = await api<{ file: StoredPdf }>(`/api/invoices/${invoiceId}/pdf`, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: bytes as BodyInit,
  });
  return file;
}
