import { deriveClientType, isPlaceholderTaxId } from "../../shared/client";
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
import {
  type NumberingSeriesData,
  type NumberingSeriesRecord,
  seriesRequestBody,
} from "../../shared/numbering";
import { api } from "../lib/api";
import { missingSeries } from "./fic-summary";
import { type ReadFile, readImportFile } from "./read";
import { summarizeInvoice, vatIdOf } from "./summary";
import { xmlDraftFromInvoice } from "./xml-draft";

/**
 * Runs an import of invoice files (XML, P7M, ZIP): reads each file in the browser, checks it, and
 * sends the original with a summary to the Worker, one file at a time so a slow or broken file
 * never stops the others. Reports progress between files and returns one result per file.
 */

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
  /** Mark the imported issued and received invoices paid (historic invoices are usually settled). */
  markPaid?: boolean;
  /** The owner's VAT id with country (`IT01234567890`), to tell issued from received files. */
  ownVat: string;
  /** The owner's codice fiscale, when set: a file issued by it is the owner's too. */
  ownTaxCode?: string | null;
  /** Today (Europe/Rome, `YYYY-MM-DD`): an issued invoice dated after it is not issued yet. */
  today: string;
  /** The numbering series that exist now; the ones the issued numbers need are created. */
  series?: NumberingSeriesRecord[];
  /** The text of a result row ("Issued 5/CH, 2025-03-31, Acme"). */
  label?: (kind: "issued" | "received", number: string, date: string, name: string) => string;
  onProgress?: (progress: ImportProgress) => void;
}

export interface ImportOutcome {
  items: ImportItemResult[];
  /** Numbering series created for the issued numbers (`5/CH` needs one with the suffix `/CH`). */
  createdSeries: NumberingSeriesData[];
}

/** A folder named like "not sent" in the path of an archive entry: the invoice was never sent. */
const NOT_SENT_FOLDER = /(^|\/)[^/]*(non[\s_-]*inviat|not[\s_-]*sent|unsent)[^/]*\//i;

const DEFAULT_RECIPIENT = new Set(["0000000", "XXXXXXX"]);

/** The tax id as written, or an empty text for a placeholder such as `ESTERO` or `0000000`. */
const realTaxId = (value: string | null | undefined): string =>
  isPlaceholderTaxId(value) ? "" : (value ?? "");

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
    vatNumber: country === "IT" ? realTaxId(customer.vatId?.code) : "",
    taxCode: realTaxId(customer.taxCode),
    foreignTaxId: country === "IT" ? "" : realTaxId(customer.vatId?.code),
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
      vatCode: realTaxId(invoice.customer.vatId?.code) || null,
      taxCode: realTaxId(invoice.customer.taxCode) || null,
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

/** The invoice files read from the picks, classified: issued by the owner, or received. */
interface Entry {
  file: ReadFile;
  kind: "issued" | "received" | null;
  summary: ReceivedSummary | null;
  /** Issued only: never sent (a "not sent" folder, or dated after today). */
  unsent: boolean;
}

function classify(file: ReadFile, options: ImportOptions): Entry {
  const summary = file.invoice ? summarizeInvoice(file.invoice) : null;
  if (!file.invoice || !summary) return { file, kind: null, summary: null, unsent: false };
  const supplier = file.invoice.supplier;
  const own =
    vatIdOf(supplier) === options.ownVat ||
    (options.ownTaxCode != null && supplier.taxCode === options.ownTaxCode);
  const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  return {
    file,
    kind: own ? "issued" : "received",
    summary,
    unsent: own && (NOT_SENT_FOLDER.test(folder) || summary.issueDate > options.today),
  };
}

const DRAFT_NOTES = {
  unavailable: "draft_number_unavailable",
  free_text: "draft_number_free_text",
};

/** Sends one classified file; never throws (a failure becomes a skipped result). */
async function importEntry(entry: Entry, options: ImportOptions): Promise<ImportItemResult> {
  const { file, summary, kind } = entry;
  if (!kind || !summary || !file.invoice) return skipped(file.label, file.reason ?? "unreadable");
  const invoice = file.invoice;
  const label = options.label
    ? options.label(
        kind,
        summary.number,
        summary.issueDate,
        kind === "issued" ? invoice.customer.name : summary.supplierName,
      )
    : file.label;
  const tag = <T extends ImportItemResult>(item: T): T => ({ ...item, kind });
  try {
    if (kind === "received") {
      const result = await upload("/api/received/import", file, {
        fileName: file.fileName,
        summary,
        paid: options.markPaid ?? false,
      });
      return tag(
        result.outcome === "imported"
          ? { label, status: "imported", id: result.id }
          : skipped(label, "duplicate", undefined, result.id),
      );
    }
    if (summary.documentType !== "TD01" && summary.documentType !== "TD04") {
      return tag(skipped(label, "unsupported_document_type", summary.documentType));
    }
    if (invoice.documents.length > 1) return tag(skipped(label, "multiple_documents"));
    const meta = issuedMeta(file, invoice, summary, options.markPaid ?? false);
    if (!meta) return tag(skipped(label, "unreadable"));
    let result: ImportFileOutcome | { outcome: "invalid" };
    if (entry.unsent) {
      const draft = xmlDraftFromInvoice(invoice, meta.customer);
      if (!draft) return tag(skipped(label, "unreadable"));
      result = await api<ImportFileOutcome | { outcome: "invalid" }>("/api/invoices/import-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
    } else {
      result = await upload("/api/invoices/import", file, meta);
    }
    if (result.outcome === "imported") {
      const note = result.numberNote ? DRAFT_NOTES[result.numberNote] : undefined;
      return tag({
        label,
        status: "imported",
        id: result.id,
        ...(entry.unsent ? { draft: true } : {}),
        ...(note
          ? { detail: note }
          : result.clientLinked === false && !entry.unsent
            ? { detail: "no_client" }
            : {}),
      });
    }
    if (result.outcome === "number_conflict") {
      return tag(skipped(label, "number_conflict", result.number, result.id));
    }
    if (result.outcome === "invalid") return tag(skipped(label, "server_error"));
    return tag(skipped(label, "duplicate", undefined, result.id));
  } catch (error) {
    const status = (error as { status?: number }).status;
    return tag(skipped(label, status === 413 ? "too_large" : "server_error"));
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const unreadable = (name: string): ReadFile => ({
  label: name,
  fileName: name,
  path: name,
  original: new Uint8Array(),
  invoice: null,
  reason: "unreadable",
});

/**
 * Imports every picked file (archives expand to their invoice files). Each file is told apart
 * automatically: issued when its supplier is the owner, received otherwise. The numbering series
 * the issued numbers need are created first. Issued invoices that were never sent are created last,
 * as unsent invoices, so their numbers are asked for above the issued ones.
 */
export async function runInvoiceImport(
  picked: PickedFile[],
  options: ImportOptions,
): Promise<ImportOutcome> {
  const files: ReadFile[] = [];
  let done = 0;
  let total = picked.length;
  const report = (label: string) => options.onProgress?.({ done, total, label });
  for (const file of picked) {
    report(file.name);
    // Let the page paint the progress before the heavy parsing blocks the thread.
    await tick();
    try {
      files.push(...readImportFile(file.name, await file.read()));
    } catch {
      files.push(unreadable(file.name));
    }
    done += 1;
  }
  const entries = files.map((file) => classify(file, options));

  // Numbers like `5/CH` only block reuse inside a series with that suffix: create the missing ones.
  const createdSeries: NumberingSeriesData[] = [];
  const wanted = missingSeries(
    entries
      .filter((e) => e.kind === "issued" && e.summary)
      .map((e) => (e.summary as ReceivedSummary).number),
    options.series ?? [],
  );
  for (const series of wanted) {
    try {
      await api("/api/numbering-series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(seriesRequestBody(series)),
      });
      createdSeries.push(series);
    } catch {
      // A series taken meanwhile only means those numbers block nothing.
    }
  }

  const ordered = [
    ...entries.filter((entry) => !entry.unsent),
    ...entries
      .filter((entry) => entry.unsent)
      .sort((a, b) => (a.summary?.issueDate ?? "").localeCompare(b.summary?.issueDate ?? "")),
  ];
  total = ordered.length;
  done = 0;
  const items: ImportItemResult[] = [];
  for (const entry of ordered) {
    report(entry.file.label);
    await tick();
    items.push(await importEntry(entry, options));
    done += 1;
  }
  options.onProgress?.({ done, total, label: "" });
  return { items, createdSeries };
}
