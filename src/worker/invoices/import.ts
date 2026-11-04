import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
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

/** An existing client for the customer (same VAT number, codice fiscale or foreign tax id). */
async function findClient(db: D1Database, meta: IssuedImportMeta): Promise<string | null> {
  const { vatCountry, vatCode, taxCode } = meta.customer;
  const candidates: [string, string | null][] = [
    ["vat_number", vatCountry === "IT" ? vatCode : null],
    ["foreign_tax_id", vatCountry && vatCountry !== "IT" ? vatCode : null],
    ["tax_code", taxCode],
  ];
  for (const [column, value] of candidates) {
    if (!value) continue;
    const row = await db
      .prepare(`SELECT id FROM clients WHERE ${column} = ? LIMIT 1`)
      .bind(value)
      .first<{ id: string }>();
    if (row) return row.id;
  }
  return null;
}

/** The client of the invoice: an existing one, else one created from the file when it is valid. */
async function resolveClient(
  db: D1Database,
  meta: IssuedImportMeta,
): Promise<{ id: string; created: boolean } | null> {
  const found = await findClient(db, meta);
  if (found) return { id: found, created: false };
  const data = importClient(meta.customer.client);
  if (!data) return null;
  const [row] = await drizzle(db, { schema })
    .insert(schema.clients)
    .values({ ...data, updatedAt: new Date() })
    .returning({ id: schema.clients.id });
  return row ? { id: row.id, created: true } : null;
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
    await db
      .prepare(
        `INSERT INTO invoices (id, document_type, state, state_rank, payment_flag, paid_date, source,
           client_id, number_raw, number_int, series_id, year, issue_date, planned_date, due_date,
           currency, total_cents, created_at)
         VALUES (?, ?, 'delivered', ?, ?, ?, 'imported', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        meta.documentType,
        INVOICE_STATES.indexOf("delivered"),
        meta.paid ? "paid" : "unpaid",
        meta.paid ? meta.date : null,
        client?.id ?? null,
        meta.number,
        progressive,
        seriesId,
        year,
        meta.date,
        meta.date,
        meta.dueDate,
        meta.currency,
        meta.totalCents,
        Date.now(),
      )
      .run();
  } catch {
    // Another request took the number between the check and the insert.
    await storage.delete(stored.id);
    throw makeError("conflict", "number_unavailable");
  }
  return { outcome: "imported", id, clientLinked: client !== null };
}
