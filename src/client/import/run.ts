import { deriveClientType } from "../../shared/client";
import type { ReceivedInvoice } from "../../shared/fatturapa";
import {
  encodeImportMeta,
  IMPORT_META_HEADER,
  type ImportFileOutcome,
  type ImportItemResult,
  type ImportReason,
  type IssuedImportMeta,
  type ReceivedSummary,
} from "../../shared/import";
import { api } from "../lib/api";
import { type ReadFile, readImportFile } from "./read";
import { summarizeInvoice, vatIdOf } from "./summary";

/**
 * Runs an import of invoice files (XML, P7M, ZIP): reads each file in the browser, checks it, and
 * sends the original with a summary to the Worker, one file at a time so a slow or broken file
 * never stops the others. Reports progress between files and returns one result per file.
 */

export type ImportKind = "received" | "issued";

export interface PickedFile {
  name: string;
  read: () => Promise<Uint8Array>;
}

export interface ImportProgress {
  /** Files (or archive entries) handled so far. */
  done: number;
  /** Picked files; archives add their entries as they are opened. */
  total: number;
  /** What is being read now. */
  label: string;
}

export interface ImportOptions {
  kind: ImportKind;
  /** Issued only: mark the imported invoices paid (historic invoices are usually settled). */
  markPaid?: boolean;
  /** The owner's VAT id with country (`IT01234567890`), to tell issued from received files. */
  ownVat: string | null;
  onProgress?: (progress: ImportProgress) => void;
}

const DEFAULT_RECIPIENT = new Set(["0000000", "XXXXXXX"]);

/** A client record built from the customer of an issued invoice file (checked by the Worker). */
function customerClient(invoice: ReceivedInvoice, currency: string): Record<string, unknown> {
  const customer = invoice.customer;
  const country = customer.address.country || customer.vatId?.country || "IT";
  const personal = customer.vatId === null && (customer.taxCode?.length ?? 0) === 16;
  const type = deriveClientType(personal ? "private" : "company", country);
  const recipient = invoice.transmission.recipientCode;
  return {
    type,
    name: customer.name.slice(0, 80),
    vatNumber: country === "IT" ? (customer.vatId?.code ?? "") : "",
    taxCode: customer.taxCode ?? "",
    foreignTaxId: country === "IT" ? "" : (customer.vatId?.code ?? ""),
    countryCode: country,
    address: [customer.address.street, customer.address.streetNumber].filter(Boolean).join(" "),
    postalCode: customer.address.postalCode,
    city: customer.address.city,
    province: customer.address.province ?? "",
    recipientCode: DEFAULT_RECIPIENT.has(recipient) ? "" : recipient,
    pec: invoice.transmission.pec ?? "",
    email: customer.email ?? "",
    pdfLanguage: country === "IT" ? "it" : "en",
    currency,
    defaults: {},
  };
}

function issuedMeta(
  file: ReadFile,
  invoice: ReceivedInvoice,
  summary: ReceivedSummary,
  markPaid: boolean,
): IssuedImportMeta | null {
  const document = invoice.documents[0];
  if (!document || summary.totalCents === null) return null;
  const due = document.payments.map((p) => p.dueDate).find((date) => date) ?? null;
  return {
    fileName: file.fileName,
    documentType: summary.documentType as "TD01" | "TD04",
    number: summary.number,
    date: summary.issueDate,
    dueDate: due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null,
    currency: summary.currency,
    totalCents: summary.totalCents,
    paid: markPaid,
    customer: {
      name: invoice.customer.name,
      vatCountry: invoice.customer.vatId?.country ?? null,
      vatCode: invoice.customer.vatId?.code ?? null,
      taxCode: invoice.customer.taxCode,
      client: customerClient(invoice, summary.currency),
    },
  };
}

const upload = (path: string, file: ReadFile, meta: unknown) =>
  api<ImportFileOutcome>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      [IMPORT_META_HEADER]: encodeImportMeta(meta),
    },
    body: file.original as BodyInit,
  });

function skipped(label: string, reason: ImportReason, detail?: string, id?: string) {
  const item: ImportItemResult = { label, status: "skipped", reason };
  if (detail !== undefined) item.detail = detail;
  if (id !== undefined) item.id = id;
  return item;
}

/** Checks one read file and sends it; never throws (a failure becomes a skipped result). */
export async function importReadFile(
  file: ReadFile,
  options: ImportOptions,
): Promise<ImportItemResult> {
  const { label } = file;
  if (file.reason || !file.invoice) return skipped(label, file.reason ?? "unreadable");
  const invoice = file.invoice;
  const summary = summarizeInvoice(invoice);
  if (!summary) return skipped(label, "unreadable");
  const own = options.ownVat;
  const supplierVat = vatIdOf(invoice.supplier);
  const ownSupplier = own !== null && supplierVat === own;
  try {
    if (options.kind === "received") {
      if (ownSupplier) return skipped(label, "issued_by_owner");
      const result = await upload("/api/received/import", file, {
        fileName: file.fileName,
        summary,
      });
      return result.outcome === "imported"
        ? { label, status: "imported", id: result.id }
        : skipped(label, "duplicate", undefined, result.id);
    }
    if (own !== null && !ownSupplier) return skipped(label, "not_issued_by_owner");
    if (summary.documentType !== "TD01" && summary.documentType !== "TD04") {
      return skipped(label, "unsupported_document_type", summary.documentType);
    }
    if (invoice.documents.length > 1) return skipped(label, "multiple_documents");
    const meta = issuedMeta(file, invoice, summary, options.markPaid ?? false);
    if (!meta) return skipped(label, "unreadable");
    const result = await upload("/api/invoices/import", file, meta);
    if (result.outcome === "imported") {
      return {
        label,
        status: "imported",
        id: result.id,
        ...(result.clientLinked === false ? { detail: "no_client" } : {}),
      };
    }
    if (result.outcome === "number_conflict") {
      return skipped(label, "number_conflict", result.number, result.id);
    }
    return skipped(label, "duplicate", undefined, result.id);
  } catch (error) {
    const status = (error as { status?: number }).status;
    return skipped(label, status === 413 ? "too_large" : "server_error");
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Imports every picked file (archives expand to their entries). */
export async function runInvoiceImport(
  picked: PickedFile[],
  options: ImportOptions,
): Promise<ImportItemResult[]> {
  const results: ImportItemResult[] = [];
  let total = picked.length;
  let done = 0;
  const report = (label: string) => options.onProgress?.({ done, total, label });
  for (const file of picked) {
    report(file.name);
    // Let the page paint the progress before the heavy parsing blocks the thread.
    await tick();
    let entries: ReadFile[];
    try {
      entries = readImportFile(file.name, await file.read());
    } catch {
      entries = [
        {
          label: file.name,
          fileName: file.name,
          original: new Uint8Array(),
          invoice: null,
          reason: "unreadable",
        },
      ];
    }
    // An archive counts once for itself and once more for each extra entry.
    total += Math.max(0, entries.length - 1);
    for (const entry of entries) {
      report(entry.label);
      await tick();
      results.push(await importReadFile(entry, options));
      done += 1;
    }
  }
  options.onProgress?.({ done, total, label: "" });
  return results;
}
