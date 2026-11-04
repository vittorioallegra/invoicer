import { Hono } from "hono";
import { romeDateTime } from "../../shared/cron";
import {
  decodeImportMeta,
  IMPORT_META_HEADER,
  type ImportFileOutcome,
  parsedResultSchema,
  receivedImportMetaSchema,
} from "../../shared/import";
import { invoiceMetaSchema } from "../../shared/invoice";
import { MAX_FILE_BYTES } from "../../shared/limits";
import type { ReceivedInvoiceRecord } from "../../shared/received";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { makeError } from "../problem";
import { createD1FileStorage, sha256Hex } from "../storage";
import { validationDetail } from "../validation";

/**
 * Received (purchase) invoices. The mailbox poll stores each one with its original file and
 * `parse_status = pending`; the browser reads the file (XML, P7M or a raw PEC message), shows it,
 * and reports the summary back (`PUT /:id/parsed`). The Worker never parses an invoice: it stores
 * what the browser found and serves the original.
 */
export const received = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

interface Row {
  id: string;
  parse_status: ReceivedInvoiceRecord["parseStatus"];
  supplier_name: string | null;
  supplier_vat: string | null;
  number: string | null;
  issue_date: string | null;
  document_type: string | null;
  currency: string;
  total_cents: number | null;
  payment_flag: "unpaid" | "paid" | "overdue";
  paid_date: string | null;
  pec_message_id: string | null;
  created_at: number;
  file_name: string | null;
  file_kind: string | null;
  file_size: number | null;
}

const SELECT = `SELECT r.id, r.parse_status, r.supplier_name, r.supplier_vat, r.number, r.issue_date,
  r.document_type, r.currency, r.total_cents, r.payment_flag, r.paid_date, r.pec_message_id,
  r.created_at, f.filename AS file_name, f.kind AS file_kind, f.size AS file_size
  FROM received_invoices r LEFT JOIN files f ON f.id = r.file_id`;

function toRecord(row: Row): ReceivedInvoiceRecord {
  return {
    id: row.id,
    parseStatus: row.parse_status,
    supplierName: row.supplier_name,
    supplierVat: row.supplier_vat,
    number: row.number,
    issueDate: row.issue_date,
    documentType: row.document_type,
    currency: row.currency,
    totalCents: row.total_cents,
    paymentFlag: row.payment_flag === "paid" ? "paid" : "unpaid",
    paidDate: row.paid_date,
    source: row.pec_message_id ? "pec" : "import",
    receivedAt: row.created_at,
    original:
      row.file_name && row.file_kind && row.file_size !== null
        ? { fileName: row.file_name, kind: row.file_kind, size: row.file_size }
        : null,
  };
}

async function requireRecord(db: D1Database, id: string): Promise<ReceivedInvoiceRecord> {
  const row = await db.prepare(`${SELECT} WHERE r.id = ?`).bind(id).first<Row>();
  if (!row) throw makeError("not_found");
  return toRecord(row);
}

/** Newest first; invoices not read yet come first so the browser can finish them. */
received.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `${SELECT} ORDER BY r.issue_date IS NOT NULL, r.issue_date DESC, r.created_at DESC`,
  ).all<Row>();
  return c.json({ received: results.map(toRecord) });
});

received.get("/:id", async (c) =>
  c.json({ received: await requireRecord(c.env.DB, c.req.param("id")) }),
);

/** The stored original (XML, P7M, or the whole PEC message for a large one). */
received.get("/:id/file", async (c) => {
  const row = await c.env.DB.prepare("SELECT file_id FROM received_invoices WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ file_id: string | null }>();
  const file = row?.file_id ? await createD1FileStorage(c.env.DB).get(row.file_id) : null;
  if (!file) throw makeError("not_found");
  return new Response(file.content, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename.replaceAll('"', "")}"`,
      "Content-Length": String(file.size),
      "Cache-Control": "private, no-store",
    },
  });
});

/** What the browser found when it read the file (or that it could not). */
received.put("/:id/parsed", async (c) => {
  const id = c.req.param("id");
  const parsed = parsedResultSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const body = parsed.data;
  const result =
    body.status === "failed"
      ? await c.env.DB.prepare("UPDATE received_invoices SET parse_status = 'failed' WHERE id = ?")
          .bind(id)
          .run()
      : await c.env.DB.prepare(
          `UPDATE received_invoices SET parse_status = 'parsed', supplier_name = ?, supplier_vat = ?,
             number = ?, issue_date = ?, document_type = ?, currency = ?, total_cents = ?
           WHERE id = ?`,
        )
          .bind(
            body.summary.supplierName,
            body.summary.supplierVat,
            body.summary.number,
            body.summary.issueDate,
            body.summary.documentType,
            body.summary.currency,
            body.summary.totalCents,
            id,
          )
          .run();
  if (result.meta.changes === 0) throw makeError("not_found");
  return c.json({ received: await requireRecord(c.env.DB, id) });
});

/** Paid / unpaid by hand (a received invoice has no due date here, so there is no `overdue`). */
received.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const parsed = invoiceMetaSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", "body: invalid");
  const meta = parsed.data;
  if (meta.paymentFlag === undefined) throw makeError("bad_request", "paymentFlag: required");
  const result = await c.env.DB.prepare(
    "UPDATE received_invoices SET payment_flag = ?, paid_date = ? WHERE id = ?",
  )
    .bind(
      meta.paymentFlag,
      meta.paymentFlag === "paid" ? (meta.paidDate ?? romeDateTime(new Date()).date) : null,
      id,
    )
    .run();
  if (result.meta.changes === 0) throw makeError("not_found");
  return c.json({ received: await requireRecord(c.env.DB, id) });
});

const contentTypeOf = (name: string) =>
  /\.p7m$/i.test(name)
    ? "application/pkcs7-mime"
    : /\.xml$/i.test(name)
      ? "application/xml"
      : "application/octet-stream";

/**
 * Manual import of a received invoice file the browser already read: the body is the original
 * file, the summary travels in a header. A file already stored (same bytes, or the same supplier,
 * number and date) is reported as a duplicate and stored nowhere.
 */
received.post("/import", async (c) => {
  const length = Number(c.req.header("Content-Length") ?? 0);
  if (length > MAX_FILE_BYTES) throw makeError("payload_too_large");
  const content = new Uint8Array(await c.req.arrayBuffer());
  if (content.byteLength > MAX_FILE_BYTES) throw makeError("payload_too_large");
  if (content.byteLength === 0) throw makeError("bad_request", "body: invalid");
  const meta = receivedImportMetaSchema.safeParse(
    decodeImportMeta(c.req.header(IMPORT_META_HEADER)),
  );
  if (!meta.success) throw makeError("bad_request", `${IMPORT_META_HEADER}: invalid`);
  const { fileName, summary } = meta.data;
  const db = c.env.DB;

  const sha = await sha256Hex(content);
  const same = await db
    .prepare(
      `SELECT r.id FROM received_invoices r JOIN files f ON f.id = r.file_id
       WHERE f.sha256 = ?1 OR (r.number = ?2 AND r.issue_date = ?3
         AND (r.supplier_vat = ?4 OR (?4 IS NULL AND r.supplier_name = ?5)))
       LIMIT 1`,
    )
    .bind(sha, summary.number, summary.issueDate, summary.supplierVat, summary.supplierName)
    .first<{ id: string }>();
  if (same) return c.json({ outcome: "duplicate", id: same.id } satisfies ImportFileOutcome);

  const id = crypto.randomUUID();
  const storage = createD1FileStorage(db);
  const stored = await storage.put({
    kind: "import",
    filename: fileName,
    contentType: contentTypeOf(fileName),
    content,
    receivedInvoiceId: id,
  });
  try {
    await db
      .prepare(
        `INSERT INTO received_invoices (id, pec_message_id, parse_status, file_id, supplier_name,
           supplier_vat, number, issue_date, document_type, currency, total_cents, created_at)
         VALUES (?, NULL, 'parsed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        stored.id,
        summary.supplierName,
        summary.supplierVat,
        summary.number,
        summary.issueDate,
        summary.documentType,
        summary.currency,
        summary.totalCents,
        Date.now(),
      )
      .run();
  } catch (error) {
    await storage.delete(stored.id);
    throw error;
  }
  return c.json({ outcome: "imported", id } satisfies ImportFileOutcome, 201);
});
