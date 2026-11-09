import { z } from "zod";
import { clientInputSchema } from "./client";
import { invoiceLineSchema } from "./invoice";
import { cassaDefaultsSchema, ritenutaDefaultsSchema } from "./tax";

/**
 * Shapes shared by the import screens (browser) and the import endpoints (Worker). The browser
 * reads the files (XML, P7M, ZIP: heavy work that does not fit the Worker's CPU limit) and sends
 * each original file with a small summary of what it found; the Worker validates the summary,
 * checks duplicates and numbers, and stores both.
 */

/** Request header carrying the JSON summary (URI-encoded) next to a raw file body. */
export const IMPORT_META_HEADER = "X-Invoicer-Meta";

export const encodeImportMeta = (meta: unknown): string => encodeURIComponent(JSON.stringify(meta));

export function decodeImportMeta(header: string | undefined): unknown {
  if (!header) return null;
  try {
    return JSON.parse(decodeURIComponent(header));
  } catch {
    return null;
  }
}

/** Why a file or row was skipped. Every code has a message under `import.reason.` in the locales. */
export const IMPORT_REASONS = [
  /** Same invoice already stored (same file, or same supplier/number/date). */
  "duplicate",
  /** The number is already taken in that series and year by another invoice. */
  "number_conflict",
  /** The file is not a FatturaPA invoice (or a P7M/ZIP that cannot be read). */
  "unreadable",
  "unsupported_document_type",
  "multiple_documents",
  "too_large",
  "empty_archive",
  "server_error",
  /** A CSV row that fails the client rules (see the row's `problems`). */
  "invalid_row",
] as const;
export type ImportReason = (typeof IMPORT_REASONS)[number];

/** One line of the result screen: one file, one document of a file, or one CSV row. */
export interface ImportItemResult {
  /** File name (or `file.zip/inner.xml`), or `Row 3` for a CSV row (the UI formats it). */
  label: string;
  status: "imported" | "skipped";
  reason?: ImportReason;
  /** Extra text for the reason (CSV: the field and rule that failed; conflict: the number). */
  detail?: string;
  /** Stored id of an imported (or already existing) record. */
  id?: string;
  /** Imported as an unsent invoice to complete and send (not sent yet, or dated after today). */
  draft?: boolean;
  /** Which list the record belongs to (the combined invoice import mixes both). */
  kind?: "issued" | "received";
}

/** Decimal text from a FatturaPA file ("1234.50", "-12.5") as integer cents; null when invalid. */
export function decimalToCents(value: string): number | null {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, whole = "0", fraction = ""] = match;
  const padded = `${fraction}000`;
  let cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  // Half-up on the third decimal.
  if (Number(padded.charAt(2)) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) return null;
  return sign === "-" ? -cents : cents;
}

const text = (max: number) => z.string().trim().max(max);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date");
const currency = z.string().regex(/^[A-Z]{3}$/, "invalid_currency");
const cents = z.number().int().min(-99_999_999_999).max(99_999_999_999);

/** What the browser read from a received invoice file. */
export const receivedSummarySchema = z.object({
  supplierName: text(200).min(1),
  supplierVat: text(40).nullable(),
  number: text(40).min(1),
  issueDate: dateOnly,
  documentType: text(10).min(1),
  currency,
  totalCents: cents.nullable(),
});
export type ReceivedSummary = z.infer<typeof receivedSummarySchema>;

/** Body of `PUT /api/received/:id/parsed`: the result of reading a polled invoice in the browser. */
export const parsedResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("failed") }),
  z.object({ status: z.literal("parsed"), summary: receivedSummarySchema }),
]);

/** Header summary of `POST /api/received/import`. */
export const receivedImportMetaSchema = z.object({
  fileName: text(200).min(1),
  summary: receivedSummarySchema,
  /** Mark the imported invoice paid on its invoice date (historic invoices usually are). */
  paid: z.boolean().default(false),
});

/** Header summary of `POST /api/invoices/import` (a historic issued invoice). */
export const issuedImportMetaSchema = z.object({
  fileName: text(200).min(1),
  documentType: z.enum(["TD01", "TD04"]),
  number: text(20).min(1),
  date: dateOnly,
  dueDate: dateOnly.nullable(),
  currency,
  totalCents: cents,
  /** Mark the imported invoice paid (historic invoices usually are). */
  paid: z.boolean(),
  /** The customer as written in the file, to link or create a client. */
  customer: z.object({
    name: text(200).min(1),
    vatCountry: text(2).nullable(),
    vatCode: text(40).nullable(),
    taxCode: text(40).nullable(),
    /** A client record built from the file; used only when it passes the client rules. */
    client: z.unknown().nullable(),
  }),
});
export type IssuedImportMeta = z.infer<typeof issuedImportMetaSchema>;

/**
 * An issued invoice file that was never sent (kept in a "not sent" folder of the export, or dated
 * after today), read in the browser: the real content of the file, to be created as an unsent
 * invoice (`POST /api/invoices/import-draft`). The original file is not stored. Anything the
 * editor cannot model (an unknown cassa type, a ritenuta cause...) is simply left out.
 */
export const xmlDraftSchema = z.object({
  documentType: z.enum(["TD01", "TD04"]),
  number: text(20).min(1),
  date: dateOnly,
  currency,
  customer: issuedImportMetaSchema.shape.customer,
  lines: z.array(invoiceLineSchema).min(1).max(500),
  cassa: cassaDefaultsSchema.nullable(),
  ritenuta: ritenutaDefaultsSchema.nullable(),
  bollo: z.enum(["none", "client", "issuer"]),
  note: text(2000),
  payment: z
    .object({
      method: text(4).nullable(),
      iban: text(40).nullable(),
      dueDate: dateOnly.nullable(),
    })
    .nullable(),
});
export type XmlDraft = z.infer<typeof xmlDraftSchema>;

/** The client record of an import customer, or null when it does not pass the client rules. */
export function importClient(client: unknown): z.output<typeof clientInputSchema> | null {
  const parsed = clientInputSchema.safeParse(client);
  return parsed.success ? parsed.data : null;
}

/** The answer for one imported file or draft (`invalid`: the Worker could not store it). */
export type ImportOutcome = ImportFileOutcome | { outcome: "invalid" };

/** Response of the two file import endpoints. */
export type ImportFileOutcome =
  | {
      outcome: "imported";
      id: string;
      clientLinked?: boolean;
      /** Drafts only: why the invoice was created without its number (to set in the editor). */
      numberNote?: "unavailable" | "free_text";
    }
  | { outcome: "duplicate"; id: string }
  | { outcome: "number_conflict"; id: string; number: string };

/** Body of `POST /api/clients/import`: rows already mapped by the browser (client records as typed). */
export const clientsImportSchema = z.object({
  rows: z.array(z.unknown()).min(1).max(500),
});

/** A field of a client row and the stable code of the rule it breaks (`validation.<code>`). */
export interface RowProblem {
  field: string;
  code: string;
}

/** One answer per submitted row, in order. */
export interface ClientRowResult {
  status: "imported" | "skipped";
  reason?: ImportReason;
  problems?: RowProblem[];
  /** The stored client, or the existing one a duplicate matches. */
  id?: string;
}
