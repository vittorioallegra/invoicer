import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { ZodError } from "zod";
import * as schema from "../../db/schema";
import type { ClientRecord } from "../../shared/client";
import { romeDateTime } from "../../shared/cron";
import {
  INVOICE_LIST_SCOPES,
  type InvoiceBody,
  type InvoiceListScope,
  type InvoiceRecord,
  invoiceInputSchema,
  invoiceIssuableSchema,
  invoiceMetaSchema,
  issueMap,
} from "../../shared/invoice";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import {
  defaultSeriesId,
  nextFreeNumber,
  releaseNumber,
  reserveNumber,
} from "../invoices/numbering";
import {
  createInvoice,
  deleteInvoice,
  listInvoices,
  loadInvoice,
  recordToBody,
  updateInvoice,
} from "../invoices/store";
import { loadSendReadiness } from "../onboarding";
import { makeError } from "../problem";
import { createD1FileStorage } from "../storage";
import { toRecord } from "./clients";

/** `%PDF-`: every PDF file starts with these bytes. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

export const invoices = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

/** `path: code` pairs, the same shape the browser produces for its inline errors. */
function issueDetail(error: ZodError): string {
  return Object.entries(issueMap(error))
    .map(([path, code]) => `${path}: ${code}`)
    .join("; ");
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<InvoiceBody> {
  const parsed = invoiceInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", issueDetail(parsed.error));
  return parsed.data;
}

/** The client and the linked invoice must exist; a credit note links an invoice that has a number. */
async function checkReferences(db: D1Database, body: InvoiceBody): Promise<void> {
  if (body.clientId) {
    const client = await db
      .prepare("SELECT 1 AS hit FROM clients WHERE id = ?")
      .bind(body.clientId)
      .first();
    if (!client) throw makeError("bad_request", "clientId: not_found");
  }
  if (body.seriesId) {
    const series = await db
      .prepare("SELECT 1 AS hit FROM numbering_series WHERE id = ?")
      .bind(body.seriesId)
      .first();
    if (!series) throw makeError("bad_request", "seriesId: not_found");
  }
  if (body.linkedInvoiceId) {
    if (body.documentType !== "TD04") throw makeError("bad_request", "linkedInvoiceId: invalid");
    const linked = await db
      .prepare("SELECT document_type FROM invoices WHERE id = ?")
      .bind(body.linkedInvoiceId)
      .first<{ document_type: string }>();
    if (!linked) throw makeError("bad_request", "linkedInvoiceId: not_found");
    if (linked.document_type !== "TD01") throw makeError("bad_request", "linkedInvoiceId: invalid");
  }
}

async function requireInvoice(db: D1Database, id: string): Promise<InvoiceRecord> {
  const record = await loadInvoice(db, id);
  if (!record) throw makeError("not_found");
  return record;
}

invoices.get("/", async (c) => {
  const scope = c.req.query("scope") ?? "to_issue";
  if (!(INVOICE_LIST_SCOPES as readonly string[]).includes(scope)) {
    throw makeError("bad_request", "scope: invalid");
  }
  return c.json({ invoices: await listInvoices(c.env.DB, scope as InvoiceListScope) });
});

/**
 * The number proposed for a new invoice of the year in a series (`series` query, default series
 * when absent): highest issued in that series (app and imported) + 1.
 */
invoices.get("/next-number", async (c) => {
  const raw = c.req.query("year");
  const year = raw === undefined ? Number(romeDateTime(new Date()).date.slice(0, 4)) : Number(raw);
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw makeError("bad_request", "year: invalid");
  }
  const series = c.req.query("series") || (await defaultSeriesId(c.env.DB));
  const exists = await c.env.DB.prepare("SELECT 1 AS hit FROM numbering_series WHERE id = ?")
    .bind(series)
    .first();
  if (!exists) throw makeError("bad_request", "series: not_found");
  return c.json({ year, series, next: await nextFreeNumber(c.env.DB, year, series) });
});

invoices.post("/", async (c) => {
  const body = await readBody(c);
  await checkReferences(c.env.DB, body);
  const id = await createInvoice(c.env.DB, body);
  return c.json({ invoice: await requireInvoice(c.env.DB, id) }, 201);
});

invoices.get("/:id", async (c) =>
  c.json({ invoice: await requireInvoice(c.env.DB, c.req.param("id")) }),
);

invoices.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await readBody(c);
  await checkReferences(c.env.DB, body);
  await updateInvoice(c.env.DB, id, body);
  return c.json({ invoice: await requireInvoice(c.env.DB, id) });
});

/** A numbered invoice is never deleted: it is sent, or its number is released first. */
invoices.delete("/:id", async (c) => {
  await deleteInvoice(c.env.DB, c.req.param("id"));
  return c.body(null, 204);
});

/** Payment flag and notes change in any state (spec 3: the only edits once an invoice is out). */
invoices.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const parsed = invoiceMetaSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", issueDetail(parsed.error));
  const meta = parsed.data;
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (meta.paymentFlag !== undefined) {
    sets.push("payment_flag = ?", "paid_date = ?");
    values.push(
      meta.paymentFlag,
      meta.paymentFlag === "paid" ? (meta.paidDate ?? romeDateTime(new Date()).date) : null,
    );
  }
  if (meta.notes !== undefined) {
    sets.push("notes = ?");
    values.push(meta.notes);
  }
  const result = await c.env.DB.prepare(
    `UPDATE invoices SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
  )
    .bind(...values, Date.now(), id)
    .run();
  if (result.meta.changes === 0) throw makeError("not_found");
  return c.json({ invoice: await requireInvoice(c.env.DB, id) });
});

/** A new draft with the content of this invoice (no number, no dates, unpaid). */
invoices.post("/:id/duplicate", async (c) => {
  const source = await requireInvoice(c.env.DB, c.req.param("id"));
  const id = await createInvoice(c.env.DB, recordToBody(source));
  return c.json({ invoice: await requireInvoice(c.env.DB, id) }, 201);
});

/** A credit note (TD04) draft for an issued invoice, with its lines for a partial credit. */
invoices.post("/:id/credit-note", async (c) => {
  const source = await requireInvoice(c.env.DB, c.req.param("id"));
  if (source.documentType !== "TD01") throw makeError("conflict", "credit_note_of_credit_note");
  if (source.state !== "delivered" && source.state !== "not_delivered") {
    throw makeError("conflict", "invoice_not_issued");
  }
  const id = await createInvoice(c.env.DB, {
    ...recordToBody(source),
    documentType: "TD04",
    linkedInvoiceId: source.id,
    operationDate: null,
  });
  return c.json({ invoice: await requireInvoice(c.env.DB, id) }, 201);
});

/**
 * After the 5-day window a rejected invoice is reissued as a new draft that references it; the
 * new number and date come at send time and the old number is never reused.
 */
invoices.post("/:id/reissue", async (c) => {
  const source = await requireInvoice(c.env.DB, c.req.param("id"));
  if (source.state !== "rejected_expired") throw makeError("conflict", "reissue_not_allowed");
  if (source.reissuedById) {
    return c.json({ invoice: await requireInvoice(c.env.DB, source.reissuedById) });
  }
  const id = await createInvoice(c.env.DB, recordToBody(source), {
    reissuesInvoiceId: source.id,
  });
  return c.json({ invoice: await requireInvoice(c.env.DB, id) }, 201);
});

async function loadClient(db: D1Database, id: string | null): Promise<ClientRecord | null> {
  if (!id) return null;
  const row = await drizzle(db, { schema })
    .select()
    .from(schema.clients)
    .where(eq(schema.clients.id, id))
    .get();
  return row ? toRecord(row) : null;
}

/**
 * Reserves the number for an invoice about to be sent (called by the send flow, step 12). Needs
 * the send gate open and an invoice that passes the issuing rules; an invoice that already holds
 * its number gets it back.
 */
invoices.post("/:id/reserve-number", async (c) => {
  const id = c.req.param("id");
  const readiness = await loadSendReadiness(c.env);
  if (!readiness.ready) {
    throw makeError("conflict", `send: not_ready (${readiness.reasons.join(", ")})`);
  }
  const record = await requireInvoice(c.env.DB, id);
  if (record.state === "draft" || record.state === "planned") {
    const client = await loadClient(c.env.DB, record.clientId);
    const parsed = invoiceIssuableSchema(client).safeParse({
      ...recordToBody(record),
      plannedDate: record.plannedDate,
      dueDate: record.dueDate,
    });
    const problems = parsed.success ? {} : issueMap(parsed.error);
    if (record.linkedInvoiceId && !record.linked?.number) problems.linkedInvoiceId = "not_issued";
    if (Object.keys(problems).length > 0) {
      throw makeError(
        "bad_request",
        Object.entries(problems)
          .map(([path, code]) => `${path}: ${code}`)
          .join("; "),
      );
    }
  }
  const profile = await drizzle(c.env.DB, { schema })
    .select({ country: schema.profile.country, vatNumber: schema.profile.vatNumber })
    .from(schema.profile)
    .where(eq(schema.profile.id, 1))
    .get();
  if (!profile) throw makeError("conflict", "send: not_ready (profile_incomplete)");
  const reservation = await reserveNumber(c.env.DB, {
    invoiceId: id,
    now: new Date(),
    idPaese: profile.country,
    idCodice: profile.vatNumber,
  });
  return c.json({ reservation, invoice: await requireInvoice(c.env.DB, id) });
});

/** Gives a reserved number back, only while it is the highest of its year and nothing was sent. */
invoices.post("/:id/release-number", async (c) => {
  const id = c.req.param("id");
  await releaseNumber(c.env.DB, id);
  return c.json({ invoice: await requireInvoice(c.env.DB, id) });
});

interface TransmissionRow {
  id: string;
  attempt: number;
  file_name: string;
  send_outcome: string;
  pdf_file_id: string | null;
}

/**
 * Stores the PDF the browser generated for the invoice's current transmission attempt (the
 * highest attempt number). The PDF is named like the XML (`IT<idCodice>_<progressive>.pdf`), is
 * linked to the invoice and the attempt, and replaces an earlier PDF of the same attempt. Once an
 * attempt has been handed to the PEC its PDF is final; a resend opens a new attempt.
 */
invoices.put("/:id/pdf", async (c) => {
  const id = c.req.param("id");
  const length = Number(c.req.header("Content-Length") ?? 0);
  if (length > schema.MAX_FILE_BYTES) throw makeError("payload_too_large");
  const content = new Uint8Array(await c.req.arrayBuffer());
  if (content.byteLength === 0 || !PDF_MAGIC.every((byte, i) => content[i] === byte)) {
    throw makeError("bad_request", "body: not_a_pdf");
  }
  const current = await c.env.DB.prepare(
    `SELECT id, attempt, file_name, send_outcome, pdf_file_id FROM transmissions
     WHERE invoice_id = ? ORDER BY attempt DESC LIMIT 1`,
  )
    .bind(id)
    .first<TransmissionRow>();
  if (!current) {
    await requireInvoice(c.env.DB, id);
    throw makeError("conflict", "not_numbered");
  }
  if (current.send_outcome !== "none") throw makeError("conflict", "transmission_sent");

  const storage = createD1FileStorage(c.env.DB);
  const filename = current.file_name.replace(/\.xml$/i, ".pdf");
  const stored = await storage.put({
    kind: "pdf",
    filename,
    contentType: "application/pdf",
    content,
    invoiceId: id,
    transmissionId: current.id,
  });
  await c.env.DB.prepare("UPDATE transmissions SET pdf_file_id = ?, updated_at = ? WHERE id = ?")
    .bind(stored.id, Date.now(), current.id)
    .run();
  if (current.pdf_file_id) await storage.delete(current.pdf_file_id);
  return c.json(
    {
      file: {
        id: stored.id,
        filename,
        size: stored.size,
        sha256: stored.sha256,
        transmissionId: current.id,
        attempt: current.attempt,
      },
    },
    201,
  );
});

/** The latest stored PDF of the invoice (the highest attempt that has one). */
invoices.get("/:id/pdf", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT pdf_file_id FROM transmissions
     WHERE invoice_id = ? AND pdf_file_id IS NOT NULL ORDER BY attempt DESC LIMIT 1`,
  )
    .bind(c.req.param("id"))
    .first<{ pdf_file_id: string }>();
  const file = row ? await createD1FileStorage(c.env.DB).get(row.pdf_file_id) : null;
  if (!file) throw makeError("not_found");
  return new Response(file.content, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Content-Length": String(file.size),
      "Cache-Control": "private, no-store",
    },
  });
});
