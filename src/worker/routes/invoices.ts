import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { ZodError } from "zod";
import * as schema from "../../db/schema";
import type { ClientRecord } from "../../shared/client";
import { romeDateTime } from "../../shared/cron";
import {
  decodeImportMeta,
  IMPORT_META_HEADER,
  issuedImportMetaSchema,
  issuedSummaryBodySchema,
  issuedSummaryDraftsBodySchema,
  type SummaryImportResponse,
} from "../../shared/import";
import {
  INVOICE_LIST_SCOPES,
  type InvoiceBody,
  type InvoiceListScope,
  type InvoiceRecord,
  invoiceIssuableSchema,
  invoiceMetaSchema,
  issueMap,
  parseInvoiceDraft,
} from "../../shared/invoice";
import { invoiceFiltersSchema } from "../../shared/invoice-filters";
import { MAX_FILE_BYTES } from "../../shared/limits";
import { formatNumberWithYear } from "../../shared/numbering";
import { invoicePdfFileName } from "../../shared/pdf-name";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { importIssuedInvoice, importIssuedSummary } from "../invoices/import";
import { importSummaryDrafts } from "../invoices/import-summary-drafts";
import {
  defaultSeriesId,
  lastIssueDate,
  nextFreeNumber,
  releaseNumber,
  reserveNumber,
} from "../invoices/numbering";
import {
  createInvoice,
  dashboardStats,
  deleteInvoice,
  listFilteredInvoices,
  listInvoices,
  loadInvoice,
  recordToBody,
  updateInvoice,
} from "../invoices/store";
import { loadSendReadiness } from "../onboarding";
import { makeError } from "../problem";
import { createD1FileStorage } from "../storage";
import { validationDetail } from "../validation";
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

/** Largest raw editor form stored with an invoice (it is only text the owner typed). */
const EDITOR_FORM_MAX_CHARS = 200_000;

/**
 * Reads the body of a save: the invoice as far as it can be stored (saving never validates, see
 * `parseInvoiceDraft`) and the raw editor form (`editorForm`) that keeps what was typed verbatim.
 */
async function readBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<{ body: InvoiceBody; editorForm: string | null }> {
  const raw = await c.req.json().catch(() => null);
  const body = parseInvoiceDraft(raw);
  if (!body) throw makeError("bad_request", "body: invalid");
  const form = (raw as { editorForm?: unknown }).editorForm;
  if (form === undefined || form === null) return { body, editorForm: null };
  const text = typeof form === "object" && !Array.isArray(form) ? JSON.stringify(form) : "";
  if (text === "" || text.length > EDITOR_FORM_MAX_CHARS) {
    throw makeError("bad_request", "editorForm: invalid");
  }
  return { body, editorForm: text };
}

/**
 * A reference to something that no longer exists (a client, series or linked invoice deleted
 * meanwhile) cannot be stored: it is dropped, and finalising reports what is missing.
 */
async function resolveReferences(db: D1Database, body: InvoiceBody): Promise<InvoiceBody> {
  const exists = async (sql: string, id: string | null) =>
    id !== null && (await db.prepare(sql).bind(id).first()) !== null;
  const linked =
    body.documentType === "TD04" && body.linkedInvoiceId
      ? await db
          .prepare("SELECT document_type FROM invoices WHERE id = ?")
          .bind(body.linkedInvoiceId)
          .first<{ document_type: string }>()
      : null;
  return {
    ...body,
    clientId: (await exists("SELECT 1 FROM clients WHERE id = ?", body.clientId))
      ? body.clientId
      : null,
    seriesId: (await exists("SELECT 1 FROM numbering_series WHERE id = ?", body.seriesId))
      ? body.seriesId
      : null,
    linkedInvoiceId: linked?.document_type === "TD01" ? body.linkedInvoiceId : null,
  };
}

async function requireInvoice(db: D1Database, id: string): Promise<InvoiceRecord> {
  const record = await loadInvoice(db, id);
  if (!record) throw makeError("not_found");
  return record;
}

invoices.get("/", async (c) => {
  const scope = c.req.query("scope") ?? "to_issue";
  if (scope === "all") {
    const parsed = invoiceFiltersSchema.safeParse(c.req.query());
    if (!parsed.success) throw makeError("bad_request", "filters: invalid");
    return c.json(await listFilteredInvoices(c.env.DB, parsed.data));
  }
  if (!(INVOICE_LIST_SCOPES as readonly string[]).includes(scope)) {
    throw makeError("bad_request", "scope: invalid");
  }
  return c.json({ invoices: await listInvoices(c.env.DB, scope as InvoiceListScope) });
});

/** Home top strip: counts and the year's and month's invoiced totals (aggregated in SQL). */
invoices.get("/dashboard", async (c) => c.json(await dashboardStats(c.env.DB)));

/**
 * The number proposed for a new invoice of the year in a series (`series` query, default series
 * when absent): highest issued in that series (app and imported) + 1, with the date of that
 * highest one, before which a new number may not be dated.
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
  return c.json({
    year,
    series,
    next: await nextFreeNumber(c.env.DB, year, series),
    lastIssueDate: await lastIssueDate(c.env.DB, year, series),
  });
});

/**
 * Import of a historic issued invoice the browser read from an XML/P7M file: the body is the
 * original file, the summary travels in a header. Stored `delivered` and read-only; its number
 * blocks reuse. Answers 200 with the outcome (`imported`, `duplicate` or `number_conflict`).
 */
invoices.post("/import", async (c) => {
  if (Number(c.req.header("Content-Length") ?? 0) > MAX_FILE_BYTES) {
    throw makeError("payload_too_large");
  }
  const content = new Uint8Array(await c.req.arrayBuffer());
  if (content.byteLength > MAX_FILE_BYTES) throw makeError("payload_too_large");
  if (content.byteLength === 0) throw makeError("bad_request", "body: invalid");
  const meta = issuedImportMetaSchema.safeParse(decodeImportMeta(c.req.header(IMPORT_META_HEADER)));
  if (!meta.success) throw makeError("bad_request", `${IMPORT_META_HEADER}: invalid`);
  const outcome = await importIssuedInvoice(c.env.DB, content, meta.data);
  return c.json(outcome, outcome.outcome === "imported" ? 201 : 200);
});

/**
 * Issued rows of a Fatture in Cloud account summary, a chunk at a time (no original file). One
 * outcome per row, in order: `imported`, `duplicate`, `number_conflict` or `invalid`.
 */
invoices.post("/import-summary", async (c) => {
  const body = issuedSummaryBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw makeError("bad_request", validationDetail(body.error));
  const results = await importIssuedSummary(c.env.DB, body.data.rows);
  return c.json({ results } satisfies SummaryImportResponse);
});

/**
 * Issued rows of the summary dated after today, ten at a time: each becomes an unsent invoice (the
 * editor's save path), never a delivered one. Same outcomes as `/import-summary`, plus the
 * `numberNote` of an invoice created without its number.
 */
invoices.post("/import-summary-drafts", async (c) => {
  const body = issuedSummaryDraftsBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw makeError("bad_request", validationDetail(body.error));
  const results = await importSummaryDrafts(c.env.DB, body.data.rows);
  return c.json({ results } satisfies SummaryImportResponse);
});

invoices.post("/", async (c) => {
  const { body, editorForm } = await readBody(c);
  const id = await createInvoice(c.env.DB, await resolveReferences(c.env.DB, body), { editorForm });
  return c.json({ invoice: await requireInvoice(c.env.DB, id) }, 201);
});

invoices.get("/:id", async (c) =>
  c.json({ invoice: await requireInvoice(c.env.DB, c.req.param("id")) }),
);

invoices.put("/:id", async (c) => {
  const id = c.req.param("id");
  const { body, editorForm } = await readBody(c);
  await updateInvoice(
    c.env.DB,
    id,
    await resolveReferences(c.env.DB, body),
    new Date(),
    editorForm,
  );
  return c.json({ invoice: await requireInvoice(c.env.DB, id) });
});

/** A numbered invoice is never deleted: it is sent, or its number is released first. */
invoices.delete("/:id", async (c) => {
  await deleteInvoice(c.env.DB, c.req.param("id"));
  return c.body(null, 204);
});

/** The payment flag changes in any state (spec 3: the only edit once an invoice is out). */
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
  const result = await c.env.DB.prepare(
    `UPDATE invoices SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
  )
    .bind(...values, Date.now(), id)
    .run();
  if (result.meta.changes === 0) throw makeError("not_found");
  return c.json({ invoice: await requireInvoice(c.env.DB, id) });
});

/** The original file of an imported invoice (the XML or P7M it was read from). */
invoices.get("/:id/original", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id FROM files WHERE invoice_id = ? AND kind = 'import' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(c.req.param("id"))
    .first<{ id: string }>();
  const file = row ? await createD1FileStorage(c.env.DB).get(row.id) : null;
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

/** A new draft with the content of this invoice (no number, no dates, unpaid). */
invoices.post("/:id/duplicate", async (c) => {
  const source = await requireInvoice(c.env.DB, c.req.param("id"));
  if (source.source === "imported") throw makeError("conflict", "imported_invoice_readonly");
  const id = await createInvoice(c.env.DB, recordToBody(source));
  return c.json({ invoice: await requireInvoice(c.env.DB, id) }, 201);
});

/** A credit note (TD04) draft for an issued invoice, with its lines for a partial credit. */
invoices.post("/:id/credit-note", async (c) => {
  const source = await requireInvoice(c.env.DB, c.req.param("id"));
  if (source.source === "imported") throw makeError("conflict", "imported_invoice_readonly");
  if (source.documentType !== "TD01") throw makeError("conflict", "credit_note_of_credit_note");
  if (source.state !== "delivered" && source.state !== "not_delivered") {
    throw makeError("conflict", "invoice_not_issued");
  }
  const id = await createInvoice(c.env.DB, {
    ...recordToBody(source),
    documentType: "TD04",
    linkedInvoiceId: source.id,
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
 * Reserves the number for an invoice about to be finalised (called by the send flow, step 12).
 * Needs the company details and an invoice that passes the issuing rules; an invoice that already holds
 * its number gets it back.
 */
invoices.post("/:id/reserve-number", async (c) => {
  const id = c.req.param("id");
  // Finalizing needs the company details; the PEC setup gates only the PEC send itself (the
  // send route), so an invoice can still be finalised for the manual AdE channel.
  const readiness = await loadSendReadiness(c.env);
  if (readiness.reasons.includes("profile_incomplete")) {
    throw makeError("conflict", `send: not_ready (${readiness.reasons.join(", ")})`);
  }
  const record = await requireInvoice(c.env.DB, id);
  if (record.state === "draft" || record.state === "planned") {
    const client = await loadClient(c.env.DB, record.clientId);
    const parsed = invoiceIssuableSchema(client).safeParse({
      ...recordToBody(record),
      invoiceDate: record.invoiceDate,
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
 * highest attempt number). The PDF is named `invoice-<number>-<client>.pdf` (the XML keeps its SdI
 * file name), is linked to the invoice and the attempt, and replaces an earlier PDF of the same attempt. Once an
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
  const invoice = await requireInvoice(c.env.DB, id);
  const filename = invoicePdfFileName(
    invoice.number ? formatNumberWithYear(invoice.number, invoice.year) : current.file_name,
    invoice.clientName,
  );
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
  // Named from the invoice as it is now (number and client), not from the stored file name.
  const invoice = await requireInvoice(c.env.DB, c.req.param("id"));
  const filename = invoice.number
    ? invoicePdfFileName(formatNumberWithYear(invoice.number, invoice.year), invoice.clientName)
    : file.filename;
  return new Response(file.content, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(file.size),
      "Cache-Control": "private, no-store",
    },
  });
});
