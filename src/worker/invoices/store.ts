import { romeDateTime } from "../../shared/cron";
import {
  EMPTY_INVOICE_DATA,
  type InvoiceBody,
  type InvoiceListScope,
  type InvoiceRecord,
  type InvoiceSummary,
  invoiceDataSchema,
  REJECTION_EVENT_TYPE,
  type RejectionInfo,
  rejectionDeadline,
  safeTotals,
} from "../../shared/invoice";
import type { InvoiceState, PaymentState } from "../../shared/invoice-state";
import { INVOICE_STATES } from "../../shared/invoice-state";
import { makeError } from "../problem";

interface InvoiceRow {
  id: string;
  document_type: "TD01" | "TD04";
  state: InvoiceState;
  payment_flag: "unpaid" | "paid";
  paid_date: string | null;
  client_id: string | null;
  client_name: string | null;
  number_raw: string | null;
  number_int: number | null;
  requested_number_int: number | null;
  series_id: string;
  year: number | null;
  issue_date: string | null;
  planned_date: string | null;
  due_date: string | null;
  currency: string;
  data: string | null;
  total_cents: number | null;
  linked_invoice_id: string | null;
  reissues_invoice_id: string | null;
  notes: string | null;
}

const SELECT = `SELECT i.id, i.document_type, i.state, i.payment_flag, i.paid_date, i.client_id,
  c.name AS client_name, i.number_raw, i.number_int, i.requested_number_int, i.series_id, i.year, i.issue_date, i.planned_date,
  i.due_date, i.currency, i.data, i.total_cents, i.linked_invoice_id,
  i.reissues_invoice_id, i.notes
  FROM invoices i LEFT JOIN clients c ON c.id = i.client_id`;

const rank = (state: InvoiceState) => INVOICE_STATES.indexOf(state);

interface RejectionRow {
  invoice_id: string;
  at: number;
  payload: string | null;
}

function parseRejection(row: RejectionRow): RejectionInfo {
  let errors: RejectionInfo["errors"] = [];
  try {
    const payload = JSON.parse(row.payload ?? "null") as {
      errors?: { code?: unknown; description?: unknown }[];
    } | null;
    errors = (payload?.errors ?? []).map((error) => ({
      code: String(error.code ?? ""),
      description: String(error.description ?? ""),
    }));
  } catch {
    // A payload that is not JSON simply carries no error list.
  }
  return { at: row.at, deadline: rejectionDeadline(row.at), errors };
}

/** Latest SdI rejection per invoice, from the receipts recorded by the polling step. */
async function loadRejections(
  db: D1Database,
  invoiceIds: string[],
): Promise<Map<string, RejectionInfo>> {
  const out = new Map<string, RejectionInfo>();
  if (invoiceIds.length === 0) return out;
  const marks = invoiceIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT invoice_id, occurred_at AS at, payload FROM events
       WHERE type = ? AND invoice_id IN (${marks}) AND occurred_at IS NOT NULL
       ORDER BY occurred_at ASC`,
    )
    .bind(REJECTION_EVENT_TYPE, ...invoiceIds)
    .all<RejectionRow>();
  for (const row of results) out.set(row.invoice_id, parseRejection(row));
  return out;
}

/** After the 5-day window a rejected invoice becomes `rejected_expired` (guarded on the state). */
export async function expireRejected(db: D1Database, now: Date): Promise<void> {
  const { results } = await db
    .prepare("SELECT id FROM invoices WHERE state = 'rejected'")
    .all<{ id: string }>();
  if (results.length === 0) return;
  const rejections = await loadRejections(
    db,
    results.map((row) => row.id),
  );
  const expired = [...rejections].filter(([, info]) => now.getTime() > info.deadline);
  if (expired.length === 0) return;
  await db.batch(
    expired.map(([id]) =>
      db
        .prepare(
          `UPDATE invoices SET state = 'rejected_expired', state_rank = ?2, updated_at = ?3
           WHERE id = ?1 AND state = 'rejected'`,
        )
        .bind(id, rank("rejected_expired"), now.getTime()),
    ),
  );
}

function effectivePayment(row: InvoiceRow, today: string): PaymentState {
  if (row.payment_flag === "paid") return "paid";
  const issued = row.state !== "draft" && row.state !== "planned";
  return issued && row.due_date !== null && row.due_date < today ? "overdue" : "unpaid";
}

/** Invoices in `sending` where nothing reached the PEC yet. */
async function reservedIds(db: D1Database): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT i.id FROM invoices i WHERE i.state = 'sending'
       AND NOT EXISTS (SELECT 1 FROM transmissions t
                        WHERE t.invoice_id = i.id AND t.send_outcome <> 'none')`,
    )
    .all<{ id: string }>();
  return new Set(results.map((row) => row.id));
}

export async function loadInvoice(
  db: D1Database,
  id: string,
  now = new Date(),
): Promise<InvoiceRecord | null> {
  await expireRejected(db, now);
  const row = await db.prepare(`${SELECT} WHERE i.id = ?`).bind(id).first<InvoiceRow>();
  if (!row) return null;
  const { results: lineRows } = await db
    .prepare(
      `SELECT description, quantity_milli, unit, unit_price_cents, vat_rate_bp, natura
       FROM invoice_lines WHERE invoice_id = ? ORDER BY position`,
    )
    .bind(id)
    .all<{
      description: string;
      quantity_milli: number;
      unit: string | null;
      unit_price_cents: number;
      vat_rate_bp: number | null;
      natura: InvoiceRecord["lines"][number]["natura"];
    }>();
  const linked = row.linked_invoice_id
    ? await db
        .prepare("SELECT number_raw, issue_date FROM invoices WHERE id = ?")
        .bind(row.linked_invoice_id)
        .first<{ number_raw: string | null; issue_date: string | null }>()
    : null;
  const rejection = (await loadRejections(db, [id])).get(id) ?? null;
  const reissue = await db
    .prepare("SELECT id FROM invoices WHERE reissues_invoice_id = ? LIMIT 1")
    .bind(id)
    .first<{ id: string }>();
  const reserved = (await reservedIds(db)).has(id);
  let releasable = false;
  if (reserved && row.year !== null && row.number_int !== null) {
    const higher = await db
      .prepare("SELECT 1 AS hit FROM invoices WHERE year = ? AND series_id = ? AND number_int > ?")
      .bind(row.year, row.series_id, row.number_int)
      .first();
    releasable = !higher;
  }
  const data = invoiceDataSchema.safeParse(row.data ? JSON.parse(row.data) : null);
  return {
    id: row.id,
    documentType: row.document_type,
    state: row.state,
    paymentFlag: effectivePayment(row, romeDateTime(now).date),
    paidDate: row.paid_date,
    clientId: row.client_id,
    clientName: row.client_name,
    number: row.number_raw,
    requestedNumber: row.number_raw === null ? row.requested_number_int : null,
    seriesId: row.series_id,
    year: row.year,
    issueDate: row.issue_date,
    invoiceDate: row.planned_date,
    dueDate: row.due_date,
    currency: row.currency,
    totalCents: row.total_cents,
    linkedInvoiceId: row.linked_invoice_id,
    linked: linked ? { number: linked.number_raw, issueDate: linked.issue_date } : null,
    reissuesInvoiceId: row.reissues_invoice_id,
    notes: row.notes,
    lines: lineRows.map((line) => ({
      description: line.description,
      quantityMilli: line.quantity_milli,
      unit: line.unit,
      unitPriceCents: line.unit_price_cents,
      vatRateBp: line.vat_rate_bp,
      natura: line.natura,
    })),
    data: data.success ? data.data : EMPTY_INVOICE_DATA,
    numberReserved: reserved,
    releasable,
    rejection: row.state === "rejected" || row.state === "rejected_expired" ? rejection : null,
    reissuedById: reissue?.id ?? null,
  };
}

const SCOPE_STATES: Record<InvoiceListScope, string> = {
  to_issue: "('draft', 'planned')",
  issued: "('sending', 'sent', 'delivered', 'not_delivered', 'rejected', 'rejected_expired')",
  reserved: "('sending')",
};

export async function listInvoices(
  db: D1Database,
  scope: InvoiceListScope,
  now = new Date(),
): Promise<InvoiceSummary[]> {
  await expireRejected(db, now);
  const order =
    scope === "to_issue"
      ? "i.planned_date IS NULL, i.planned_date ASC, i.created_at DESC"
      : "i.year DESC, i.issue_date DESC, i.number_int DESC, i.created_at DESC";
  const { results } = await db
    .prepare(`${SELECT} WHERE i.state IN ${SCOPE_STATES[scope]} ORDER BY ${order}`)
    .all<InvoiceRow>();
  const reserved = await reservedIds(db);
  const rejections = await loadRejections(
    db,
    results.filter((row) => row.state === "rejected").map((row) => row.id),
  );
  const today = romeDateTime(now).date;
  const shown = results.filter((row) => scope !== "reserved" || reserved.has(row.id));
  // A reserved number can be released only while it is the highest of its series and year.
  const releasable = new Set<string>();
  for (const row of shown) {
    if (!reserved.has(row.id) || row.year === null || row.number_int === null) continue;
    const higher = await db
      .prepare("SELECT 1 AS hit FROM invoices WHERE year = ? AND series_id = ? AND number_int > ?")
      .bind(row.year, row.series_id, row.number_int)
      .first();
    if (!higher) releasable.add(row.id);
  }
  return shown.map((row) => ({
    id: row.id,
    documentType: row.document_type,
    state: row.state,
    paymentFlag: effectivePayment(row, today),
    clientName: row.client_name,
    number: row.number_raw,
    issueDate: row.issue_date,
    invoiceDate: row.planned_date,
    dueDate: row.due_date,
    currency: row.currency,
    totalCents: row.total_cents,
    numberReserved: reserved.has(row.id),
    releasable: releasable.has(row.id),
    linkedInvoiceId: row.linked_invoice_id,
    rejectionDeadline: rejections.get(row.id)?.deadline ?? null,
  }));
}

type Extra = { reissuesInvoiceId?: string | null };

function lineStatements(db: D1Database, id: string, lines: InvoiceBody["lines"]) {
  return lines.map((line, index) =>
    db
      .prepare(
        `INSERT INTO invoice_lines
           (id, invoice_id, position, description, quantity_milli, unit, unit_price_cents, vat_rate_bp, natura)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        id,
        index,
        line.description,
        line.quantityMilli,
        line.unit,
        line.unitPriceCents,
        line.vatRateBp,
        line.natura,
      ),
  );
}

function totalCents(body: InvoiceBody): number | null {
  return safeTotals(body)?.documentTotalCents ?? null;
}

/** Creates a draft (or planned invoice when a planned date is set). */
export async function createInvoice(
  db: D1Database,
  body: InvoiceBody,
  extra: Extra = {},
  now = new Date(),
): Promise<string> {
  const id = crypto.randomUUID();
  const state: InvoiceState = body.invoiceDate ? "planned" : "draft";
  await db.batch([
    db
      .prepare(
        `INSERT INTO invoices
           (id, document_type, state, state_rank, payment_flag, source, client_id, planned_date,
            due_date, currency, data, total_cents, linked_invoice_id,
            reissues_invoice_id, notes, requested_number_int, series_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'unpaid', 'app', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 COALESCE(?, (SELECT id FROM numbering_series WHERE is_default = 1)), ?, ?)`,
      )
      .bind(
        id,
        body.documentType,
        state,
        rank(state),
        body.clientId,
        body.invoiceDate,
        body.dueDate,
        body.currency,
        JSON.stringify(body.data),
        totalCents(body),
        body.linkedInvoiceId,
        extra.reissuesInvoiceId ?? null,
        body.notes,
        body.requestedNumber,
        body.seriesId,
        now.getTime(),
        now.getTime(),
      ),
    ...lineStatements(db, id, body.lines),
  ]);
  return id;
}

/**
 * Saves the content of an invoice. Draft and planned invoices change freely (the state follows
 * the planned date); a rejected one keeps its state, number and date. The first statement fails
 * on a constraint when the invoice stopped being editable meanwhile, so no line is touched.
 */
export async function updateInvoice(
  db: D1Database,
  id: string,
  body: InvoiceBody,
  now = new Date(),
): Promise<void> {
  const current = await db
    .prepare("SELECT state, document_type FROM invoices WHERE id = ?")
    .bind(id)
    .first<{ state: InvoiceState; document_type: string }>();
  if (!current) throw makeError("not_found");
  if (current.state !== "draft" && current.state !== "planned" && current.state !== "rejected") {
    throw makeError("conflict", "invoice_locked");
  }
  if (current.state === "rejected" && current.document_type !== body.documentType) {
    throw makeError("conflict", "document_type_locked");
  }
  const free = current.state !== "rejected";
  const state: InvoiceState = free ? (body.invoiceDate ? "planned" : "draft") : "rejected";
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE invoices SET state_rank = CASE
             WHEN state IN ('draft', 'planned', 'rejected') THEN state_rank ELSE NULL END
           WHERE id = ?`,
        )
        .bind(id),
      db
        .prepare(
          `UPDATE invoices SET document_type = ?2, state = CASE WHEN state = 'rejected' THEN state ELSE ?3 END,
             state_rank = CASE WHEN state = 'rejected' THEN state_rank ELSE ?4 END,
             client_id = ?5, planned_date = ?6, due_date = ?7, currency = ?8,
             data = ?9, total_cents = ?10, linked_invoice_id = ?11, notes = ?12, updated_at = ?13,
             requested_number_int = CASE WHEN number_int IS NULL THEN ?14 ELSE NULL END,
             series_id = CASE WHEN number_int IS NULL
               THEN COALESCE(?15, (SELECT id FROM numbering_series WHERE is_default = 1))
               ELSE series_id END
           WHERE id = ?1`,
        )
        .bind(
          id,
          body.documentType,
          state,
          rank(state),
          body.clientId,
          body.invoiceDate,
          body.dueDate,
          body.currency,
          JSON.stringify(body.data),
          totalCents(body),
          body.linkedInvoiceId,
          body.notes,
          now.getTime(),
          body.requestedNumber,
          body.seriesId,
        ),
      db.prepare("DELETE FROM invoice_lines WHERE invoice_id = ?").bind(id),
      ...lineStatements(db, id, body.lines),
    ]);
  } catch {
    throw makeError("conflict", "invoice_locked");
  }
}

/** Deletes an invoice that never got a number; a numbered one is kept for good. */
export async function deleteInvoice(db: D1Database, id: string): Promise<void> {
  const result = await db
    .prepare(
      `DELETE FROM invoices WHERE id = ? AND state IN ('draft', 'planned') AND number_int IS NULL`,
    )
    .bind(id)
    .run();
  if (result.meta.changes > 0) return;
  const exists = await db.prepare("SELECT 1 AS hit FROM invoices WHERE id = ?").bind(id).first();
  throw exists ? makeError("conflict", "numbered_invoice_undeletable") : makeError("not_found");
}

/** The body of an existing invoice, ready to become a new one (it never inherits a number). */
export function recordToBody(record: InvoiceRecord): InvoiceBody {
  return {
    documentType: record.documentType,
    clientId: record.clientId,
    currency: record.currency,
    requestedNumber: null,
    seriesId: record.seriesId,
    invoiceDate: null,
    dueDate: null,
    linkedInvoiceId: record.linkedInvoiceId,
    notes: record.notes,
    lines: record.lines,
    data: record.data,
  };
}
