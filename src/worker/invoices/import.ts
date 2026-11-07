import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
import {
  type ImportFileOutcome,
  type IssuedImportMeta,
  type IssuedSummaryRow,
  importClient,
  type SummaryRowOutcome,
} from "../../shared/import";
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

const clientColumns = (customer: IssuedSummaryRow["customer"]): [string, string][] =>
  (
    [
      ["vat_number", customer.vatCountry === "IT" ? customer.vatCode : null],
      [
        "foreign_tax_id",
        customer.vatCountry && customer.vatCountry !== "IT" ? customer.vatCode : null,
      ],
      ["tax_code", customer.taxCode],
    ] as [string, string | null][]
  ).filter((entry): entry is [string, string] => Boolean(entry[1]));

/**
 * Import of the issued rows of a Fatture in Cloud account summary: no original file, no lines and
 * no client record is created (a client is only linked by VAT number or codice fiscale; the name
 * is kept in `counterparty_name`). The same numbering and duplicate rules as a file import apply.
 * One round trip reads everything the rows need and one batch writes them, so a chunk of rows
 * stays within the Worker's CPU limit. Answers one outcome per row, in order.
 */
export async function importIssuedSummary(
  db: D1Database,
  rows: IssuedSummaryRow[],
): Promise<SummaryRowOutcome[]> {
  const { results: seriesRows } = await db
    .prepare("SELECT id, prefix, suffix, is_default AS isDefault FROM numbering_series")
    .all<{ id: string; prefix: string | null; suffix: string | null; isDefault: number }>();
  const series = seriesRows.map((row) => ({ ...row, isDefault: row.isDefault === 1 }));
  const planned = rows.map((row) => ({
    row,
    ...matchSeries(row.number, series),
    year: Number(row.date.slice(0, 4)),
  }));

  // Everything to look up, in one batch: the row that may hold the number, and the clients.
  const lookups: D1PreparedStatement[] = [];
  const shape = planned.map(({ row, seriesId, progressive, year }) => {
    const existing = lookups.length;
    lookups.push(
      progressive !== null
        ? db
            .prepare(
              `SELECT id, number_raw, issue_date, total_cents FROM invoices
               WHERE series_id = ? AND year = ? AND number_int = ?`,
            )
            .bind(seriesId, year, progressive)
        : db
            .prepare(
              `SELECT id, number_raw, issue_date, total_cents FROM invoices
               WHERE number_raw = ? AND issue_date = ? AND total_cents = ? LIMIT 1`,
            )
            .bind(row.number, row.date, row.totalCents),
    );
    const columns = clientColumns(row.customer);
    const first = lookups.length;
    for (const [column, value] of columns) {
      lookups.push(db.prepare(`SELECT id FROM clients WHERE ${column} = ? LIMIT 1`).bind(value));
    }
    return { existing, first, count: columns.length };
  });
  const answers = lookups.length > 0 ? await db.batch<Record<string, unknown>>(lookups) : [];

  const outcomes: SummaryRowOutcome[] = [];
  const inserts: { index: number; invoice: ImportedInvoice }[] = [];
  // Rows of this request that already took a number (the same invoice twice in one file).
  const taken = new Map<string, { id: string; row: IssuedSummaryRow }>();
  const same = (a: IssuedSummaryRow, b: { number: string; date: string; totalCents: number }) =>
    a.number === b.number && a.date === b.date && a.totalCents === b.totalCents;

  planned.forEach(({ row, seriesId, progressive, year }, index) => {
    const at = shape[index];
    if (!seriesId || !at) {
      outcomes.push({ outcome: "invalid" });
      return;
    }
    const found = answers[at.existing]?.results[0] as
      | {
          id: string;
          number_raw: string | null;
          issue_date: string | null;
          total_cents: number | null;
        }
      | undefined;
    if (found) {
      outcomes.push(
        found.number_raw === row.number &&
          found.issue_date === row.date &&
          found.total_cents === row.totalCents
          ? { outcome: "duplicate", id: found.id }
          : { outcome: "number_conflict", id: found.id, number: row.number },
      );
      return;
    }
    const key =
      progressive !== null
        ? `${seriesId}|${year}|${progressive}`
        : `${row.number}|${row.date}|${row.totalCents}`;
    const earlier = taken.get(key);
    if (earlier) {
      outcomes.push(
        same(earlier.row, row) || progressive === null
          ? { outcome: "duplicate", id: earlier.id }
          : { outcome: "number_conflict", id: earlier.id, number: row.number },
      );
      return;
    }
    let clientId: string | null = null;
    for (let i = 0; i < at.count && clientId === null; i++) {
      const hit = answers[at.first + i]?.results[0] as { id: string } | undefined;
      clientId = hit?.id ?? null;
    }
    const id = crypto.randomUUID();
    taken.set(key, { id, row });
    outcomes.push({ outcome: "imported", id, clientLinked: clientId !== null });
    inserts.push({
      index,
      invoice: {
        id,
        documentType: row.documentType,
        number: row.number,
        progressive,
        seriesId,
        date: row.date,
        dueDate: null,
        currency: row.currency,
        totalCents: row.totalCents,
        paid: row.paid,
        clientId,
        counterpartyName: row.customer.name,
      },
    });
  });

  if (inserts.length > 0) {
    try {
      await db.batch(inserts.map(({ invoice }) => insertImported(db, invoice)));
    } catch {
      // Another request took a number meanwhile (the batch is all or nothing): one by one.
      for (const { index, invoice } of inserts) {
        try {
          await insertImported(db, invoice).run();
        } catch {
          outcomes[index] = { outcome: "invalid" };
        }
      }
    }
  }
  return outcomes;
}
