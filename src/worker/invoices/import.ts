import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
import { isPlaceholderTaxId } from "../../shared/client";
import { type ImportFileOutcome, type IssuedImportMeta, importClient } from "../../shared/import";
import { INVOICE_STATES } from "../../shared/invoice-state";
import { matchSeries } from "../../shared/numbering";
import { makeError } from "../problem";
import { createD1FileStorage, sha256Hex } from "../storage";

/**
 * Import of a historic issued invoice (spec section 6). The browser read the file; this stores the
 * original and one invoice row: `source = imported`, state `delivered`, read-only. Its number
 * takes part in numbering like any issued number: the series comes from `matchSeries`, the year
 * from the invoice date, and the unique index on series + year + progressive keeps it from being
 * reused. A number free text only (no clean progressive) is stored but takes no progressive.
 */

const contentTypeOf = (name: string) =>
  /\.p7m$/i.test(name)
    ? "application/pkcs7-mime"
    : /\.xml$/i.test(name)
      ? "application/xml"
      : "application/octet-stream";

interface Existing {
  id: string;
  number_raw: string | null;
  issue_date: string | null;
  total_cents: number | null;
}

/**
 * How to recognise an existing client of an imported customer, best first: its VAT number, foreign
 * tax id or codice fiscale, as SQL conditions with their value. A placeholder tax id (`ESTERO`,
 * `0000000`) identifies nobody; a customer with no real id is recognised by its name instead.
 */
export function clientMatches(customer: {
  name: string;
  vatCountry: string | null;
  vatCode: string | null;
  taxCode: string | null;
}): [string, string][] {
  const real = (value: string | null) => (value && !isPlaceholderTaxId(value) ? value : null);
  const vat = real(customer.vatCode);
  const tax = real(customer.taxCode);
  const matches: [string, string | null][] = [
    ["vat_number = ?", customer.vatCountry === "IT" ? vat : null],
    ["foreign_tax_id = ?", customer.vatCountry && customer.vatCountry !== "IT" ? vat : null],
    ["tax_code = ?", tax],
  ];
  const byId = matches.filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (byId.length > 0) return byId;
  const name = customer.name.trim();
  return name ? [["lower(trim(name)) = lower(trim(?))", name]] : [];
}

/** An existing client for the customer (see `clientMatches`). */
async function findClient(db: D1Database, meta: IssuedImportMeta): Promise<string | null> {
  for (const [condition, value] of clientMatches(meta.customer)) {
    const row = await db
      .prepare(`SELECT id FROM clients WHERE ${condition} LIMIT 1`)
      .bind(value)
      .first<{ id: string }>();
    if (row) return row.id;
  }
  return null;
}

/** Stores a client from an import record when it passes the client rules; null otherwise. */
export async function createImportClient(db: D1Database, raw: unknown): Promise<string | null> {
  const data = importClient(raw);
  if (!data) return null;
  const [row] = await drizzle(db, { schema })
    .insert(schema.clients)
    .values({ ...data, updatedAt: new Date() })
    .returning({ id: schema.clients.id });
  return row?.id ?? null;
}

/** The client of the invoice: an existing one, else one created from the file when it is valid. */
async function resolveClient(
  db: D1Database,
  meta: IssuedImportMeta,
): Promise<{ id: string; created: boolean } | null> {
  const found = await findClient(db, meta);
  if (found) return { id: found, created: false };
  const id = await createImportClient(db, meta.customer.client);
  return id ? { id, created: true } : null;
}

interface ImportedInvoice {
  id: string;
  documentType: "TD01" | "TD04";
  number: string;
  progressive: number | null;
  seriesId: string;
  date: string;
  dueDate: string | null;
  currency: string;
  totalCents: number;
  paid: boolean;
  clientId: string | null;
  /** The customer name as written in the source, shown when no client is linked. */
  counterpartyName: string;
}

/** The statement that stores one imported issued invoice (delivered, read-only, paid or not). */
function insertImported(db: D1Database, invoice: ImportedInvoice): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO invoices (id, document_type, state, state_rank, payment_flag, paid_date, source,
         client_id, counterparty_name, number_raw, number_int, series_id, year, issue_date,
         planned_date, due_date, currency, total_cents, created_at)
       VALUES (?, ?, 'delivered', ?, ?, ?, 'imported', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      invoice.id,
      invoice.documentType,
      INVOICE_STATES.indexOf("delivered"),
      invoice.paid ? "paid" : "unpaid",
      invoice.paid ? invoice.date : null,
      invoice.clientId,
      invoice.counterpartyName,
      invoice.number,
      invoice.progressive,
      invoice.seriesId,
      Number(invoice.date.slice(0, 4)),
      invoice.date,
      invoice.date,
      invoice.dueDate,
      invoice.currency,
      invoice.totalCents,
      Date.now(),
    );
}

export async function importIssuedInvoice(
  db: D1Database,
  content: Uint8Array,
  meta: IssuedImportMeta,
): Promise<ImportFileOutcome> {
  const year = Number(meta.date.slice(0, 4));
  const { results: seriesRows } = await db
    .prepare("SELECT id, prefix, suffix, is_default AS isDefault FROM numbering_series")
    .all<{ id: string; prefix: string | null; suffix: string | null; isDefault: number }>();
  const { seriesId, progressive } = matchSeries(
    meta.number,
    seriesRows.map((row) => ({ ...row, isDefault: row.isDefault === 1 })),
  );
  if (!seriesId) throw makeError("internal_error");

  // The same file, or the same invoice, is already there.
  const sha = await sha256Hex(content);
  const sameFile = await db
    .prepare(
      `SELECT i.id FROM invoices i JOIN files f ON f.invoice_id = i.id
       WHERE f.kind = 'import' AND f.sha256 = ? LIMIT 1`,
    )
    .bind(sha)
    .first<{ id: string }>();
  if (sameFile) return { outcome: "duplicate", id: sameFile.id };

  const sameInvoice = (row: Existing) =>
    row.number_raw === meta.number &&
    row.issue_date === meta.date &&
    row.total_cents === meta.totalCents;
  if (progressive !== null) {
    const taken = await db
      .prepare(
        `SELECT id, number_raw, issue_date, total_cents FROM invoices
         WHERE series_id = ? AND year = ? AND number_int = ?`,
      )
      .bind(seriesId, year, progressive)
      .first<Existing>();
    if (taken) {
      return sameInvoice(taken)
        ? { outcome: "duplicate", id: taken.id }
        : { outcome: "number_conflict", id: taken.id, number: meta.number };
    }
  } else {
    const same = await db
      .prepare(
        `SELECT id, number_raw, issue_date, total_cents FROM invoices
         WHERE number_raw = ? AND issue_date = ? AND total_cents = ? LIMIT 1`,
      )
      .bind(meta.number, meta.date, meta.totalCents)
      .first<Existing>();
    if (same) return { outcome: "duplicate", id: same.id };
  }

  const client = await resolveClient(db, meta);
  const id = crypto.randomUUID();
  const storage = createD1FileStorage(db);
  const stored = await storage.put({
    kind: "import",
    filename: meta.fileName,
    contentType: contentTypeOf(meta.fileName),
    content,
    invoiceId: id,
  });
  try {
    await insertImported(db, {
      id,
      documentType: meta.documentType,
      number: meta.number,
      progressive,
      seriesId,
      date: meta.date,
      dueDate: meta.dueDate,
      currency: meta.currency,
      totalCents: meta.totalCents,
      paid: meta.paid,
      clientId: client?.id ?? null,
      counterpartyName: meta.customer.name,
    }).run();
  } catch {
    // Another request took the number between the check and the insert.
    await storage.delete(stored.id);
    throw makeError("conflict", "number_unavailable");
  }
  return { outcome: "imported", id, clientLinked: client !== null };
}

export const clientColumns = (
  customer: Omit<IssuedImportMeta["customer"], "client">,
): [string, string][] => clientMatches(customer);
