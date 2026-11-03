import { romeDateTime } from "../../shared/cron";
import { fileProgressiveSql } from "../../shared/fatturapa/file-name";
import { invoiceDataSchema } from "../../shared/invoice";
import { dueDate } from "../../shared/payment-terms";
import { makeError } from "../problem";

/**
 * Invoice numbering (plan step 9). A number is reserved when the owner sends, in one guarded D1
 * batch. D1 runs a batch as a single transaction, but an UPDATE that touches 0 rows does not
 * roll it back, so the first statement is an INSERT whose NOT NULL column receives NULL when the
 * invoice is not eligible: that constraint failure aborts the whole batch and nothing changes.
 *
 * Each invoice belongs to a numbering series (`series_id`) with its own yearly progressive. Next
 * number = highest number already issued in the series and year (app and imported invoices) + 1,
 * or 1, computed inside SQL so that two concurrent reservations can never read the same value. A
 * draft may carry a number the owner asked for (`requested_number_int`): it is accepted only when
 * it is above the highest number issued in that series and year (a gap is allowed), otherwise
 * nothing is reserved and `number_unavailable` is raised. The partial UNIQUE index on series +
 * year + number still guards races. The printed number (`number_raw`) is the series prefix +
 * progressive + suffix, frozen on the invoice. Year and issue date come from the Europe/Rome
 * calendar (the Worker runs in UTC).
 */

const ISSUABLE_STATES = "('draft', 'planned')";

export interface Reservation {
  invoiceId: string;
  number: number;
  /** The printed number: series prefix + progressive + suffix. */
  numberText: string;
  year: number;
  issueDate: string;
  transmission: { id: string; attempt: number; fileProgressive: number; fileName: string };
  /** True when the invoice already held its number (a repeated or concurrent reservation). */
  reused: boolean;
}

export interface ReserveInput {
  invoiceId: string;
  now: Date;
  /** Issuer VAT identification, for the file name `<IdPaese><IdCodice>_<progressive>.xml`. */
  idPaese: string;
  idCodice: string;
}

/** The id of the default numbering series. */
export async function defaultSeriesId(db: D1Database): Promise<string> {
  const row = await db
    .prepare("SELECT id FROM numbering_series WHERE is_default = 1")
    .first<{ id: string }>();
  if (!row) throw makeError("internal_error");
  return row.id;
}

/**
 * The number the editor proposes: the highest issued in the series and year (app and imported)
 * + 1.
 */
export async function nextFreeNumber(
  db: D1Database,
  year: number,
  seriesId: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT MAX(number_int) AS highest FROM invoices WHERE year = ? AND series_id = ?")
    .bind(year, seriesId)
    .first<{ highest: number | null }>();
  return (row?.highest ?? 0) + 1;
}

interface InvoiceNumberRow {
  state: string;
  number_int: number | null;
  number_raw: string | null;
  series_id: string;
  year: number | null;
  issue_date: string | null;
}

async function loadReservation(
  db: D1Database,
  invoiceId: string,
  reused: boolean,
): Promise<Reservation | null> {
  const invoice = await db
    .prepare(
      "SELECT state, number_int, number_raw, series_id, year, issue_date FROM invoices WHERE id = ?",
    )
    .bind(invoiceId)
    .first<InvoiceNumberRow>();
  if (!invoice || invoice.number_int === null || invoice.year === null || !invoice.issue_date) {
    return null;
  }
  const transmission = await db
    .prepare(
      `SELECT id, attempt, file_progressive, file_name FROM transmissions
       WHERE invoice_id = ? ORDER BY attempt DESC LIMIT 1`,
    )
    .bind(invoiceId)
    .first<{ id: string; attempt: number; file_progressive: number; file_name: string }>();
  if (!transmission) return null;
  return {
    invoiceId,
    number: invoice.number_int,
    numberText: invoice.number_raw ?? String(invoice.number_int),
    year: invoice.year,
    issueDate: invoice.issue_date,
    transmission: {
      id: transmission.id,
      attempt: transmission.attempt,
      fileProgressive: transmission.file_progressive,
      fileName: transmission.file_name,
    },
    reused,
  };
}

/**
 * The due date to store once the issue date is fixed: computed from the payment terms of the
 * invoice, unless the owner set a date by hand or there are no terms (then null: keep the stored
 * date). Pure given the stored data, so the XML and PDF show the right date.
 */
async function dueDateFromTerms(
  db: D1Database,
  invoiceId: string,
  issueDate: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT data FROM invoices WHERE id = ?")
    .bind(invoiceId)
    .first<{ data: string | null }>();
  if (!row?.data) return null;
  try {
    const parsed = invoiceDataSchema.safeParse(JSON.parse(row.data));
    const payment = parsed.success ? parsed.data.payment : null;
    return payment?.terms && !payment.dueDateCustom ? dueDate(issueDate, payment.terms) : null;
  } catch {
    return null;
  }
}

/**
 * Reserves the next number of the current Rome year for a draft or planned invoice, sets it to
 * `sending` and allocates the file progressive with a first transmission row. Repeating the call
 * for an invoice that already holds its number returns that number (two devices, or a retry).
 */
export async function reserveNumber(db: D1Database, input: ReserveInput): Promise<Reservation> {
  const { invoiceId, now, idPaese, idCodice } = input;
  const issueDate = romeDateTime(now).date;
  const year = Number(issueDate.slice(0, 4));
  const stamp = now.getTime();

  const existing = await db
    .prepare(
      "SELECT state, number_int, number_raw, series_id, year, issue_date FROM invoices WHERE id = ?",
    )
    .bind(invoiceId)
    .first<InvoiceNumberRow>();
  if (!existing) throw makeError("not_found");
  if (existing.number_int !== null) {
    const held = existing.state === "sending" ? await loadReservation(db, invoiceId, true) : null;
    if (held) return held;
    throw makeError("conflict", "already_numbered");
  }
  const seriesId = existing.series_id;
  const termsDueDate = await dueDateFromTerms(db, invoiceId, issueDate);

  try {
    await db.batch([
      // 1. Guard: fails (NOT NULL) unless the invoice is still an unnumbered draft or planned
      //    invoice of an existing series, today is not before the date of the highest number
      //    issued this year in the series, and a requested number (if any) is a positive integer
      //    above that highest number.
      db
        .prepare(
          `INSERT INTO number_sequences (series_id, year, last_number)
           SELECT ?4, ?1, CASE WHEN EXISTS (
             SELECT 1 FROM invoices
              WHERE id = ?2 AND state IN ${ISSUABLE_STATES} AND number_int IS NULL
                AND EXISTS (SELECT 1 FROM numbering_series WHERE id = ?4)
                AND ?3 >= COALESCE((SELECT issue_date FROM invoices
                                     WHERE year = ?1 AND series_id = ?4 AND number_int IS NOT NULL
                                     ORDER BY number_int DESC LIMIT 1), '')
                AND (requested_number_int IS NULL OR (
                  requested_number_int >= 1 AND requested_number_int >
                    COALESCE((SELECT MAX(number_int) FROM invoices
                               WHERE year = ?1 AND series_id = ?4), 0)))
           ) THEN 0 ELSE NULL END
           WHERE true
           ON CONFLICT (series_id, year) DO NOTHING`,
        )
        .bind(year, invoiceId, issueDate, seriesId),
      // 2. The number: the requested one (the guard accepted it) or the highest in use + 1.
      db
        .prepare(
          `UPDATE number_sequences SET last_number = COALESCE(
             (SELECT requested_number_int FROM invoices WHERE id = ?2),
             COALESCE((SELECT MAX(number_int) FROM invoices
                        WHERE year = ?1 AND series_id = ?3), 0) + 1
           ) WHERE year = ?1 AND series_id = ?3`,
        )
        .bind(year, invoiceId, seriesId),
      // 3. Assign it (progressive and printed number) and move the invoice to `sending`.
      db
        .prepare(
          `UPDATE invoices SET
             number_int = (SELECT last_number FROM number_sequences WHERE year = ?1 AND series_id = ?6),
             number_raw = COALESCE((SELECT prefix FROM numbering_series WHERE id = ?6), '')
               || CAST((SELECT last_number FROM number_sequences WHERE year = ?1 AND series_id = ?6) AS TEXT)
               || COALESCE((SELECT suffix FROM numbering_series WHERE id = ?6), ''),
             requested_number_int = NULL,
             year = ?1, issue_date = ?3, state = 'sending', state_rank = 2, updated_at = ?4,
             due_date = COALESCE(?5, due_date)
           WHERE id = ?2 AND state IN ${ISSUABLE_STATES} AND number_int IS NULL`,
        )
        .bind(year, invoiceId, issueDate, stamp, termsDueDate, seriesId),
      // 4. The global file progressive.
      db.prepare(
        `INSERT INTO file_sequence (id, last_value) VALUES (1, 1)
         ON CONFLICT (id) DO UPDATE SET last_value = last_value + 1`,
      ),
      // 5. First transmission attempt, named after the progressive.
      db
        .prepare(
          `INSERT INTO transmissions
             (id, invoice_id, attempt, file_progressive, file_name, channel, send_outcome, created_at)
           SELECT ?1, ?2, 1, last_value, ?3 || ?4 || '_' || ${fileProgressiveSql("last_value")} || '.xml',
                  'pec', 'none', ?5
           FROM file_sequence WHERE id = 1`,
        )
        .bind(crypto.randomUUID(), invoiceId, idPaese, idCodice, stamp),
    ]);
  } catch (error) {
    // The guard failed or a concurrent request won: explain which, never leave a half state.
    const now_ = await db
      .prepare(
        "SELECT state, number_int, number_raw, series_id, year, issue_date FROM invoices WHERE id = ?",
      )
      .bind(invoiceId)
      .first<InvoiceNumberRow>();
    if (!now_) throw makeError("not_found");
    if (now_.number_int !== null) {
      const held = now_.state === "sending" ? await loadReservation(db, invoiceId, true) : null;
      if (held) return held;
      throw makeError("conflict", "already_numbered");
    }
    if (now_.state !== "draft" && now_.state !== "planned") {
      throw makeError("conflict", "invoice_locked");
    }
    const seriesExists = await db
      .prepare("SELECT 1 AS hit FROM numbering_series WHERE id = ?")
      .bind(seriesId)
      .first();
    if (!seriesExists) throw makeError("conflict", "series_missing");
    const requested = await db
      .prepare("SELECT requested_number_int AS n FROM invoices WHERE id = ?")
      .bind(invoiceId)
      .first<{ n: number | null }>();
    if (requested?.n !== null && requested?.n !== undefined) {
      const next = await nextFreeNumber(db, year, seriesId);
      if (requested.n < next) {
        throw makeError(
          "number_unavailable",
          `requestedNumber: unavailable (the next free number is ${next})`,
        );
      }
    }
    const last = await db
      .prepare(
        `SELECT issue_date FROM invoices WHERE year = ? AND series_id = ? AND number_int IS NOT NULL
         ORDER BY number_int DESC LIMIT 1`,
      )
      .bind(year, seriesId)
      .first<{ issue_date: string | null }>();
    if (last?.issue_date && last.issue_date > issueDate) {
      throw makeError("conflict", `date_before_last_issue (${last.issue_date})`);
    }
    throw error;
  }

  const reservation = await loadReservation(db, invoiceId, false);
  if (!reservation) throw makeError("internal_error");
  return reservation;
}

export interface ReleaseResult {
  invoiceId: string;
  state: "draft" | "planned";
  number: number;
  year: number;
}

/**
 * Gives a reserved number back: allowed only while the invoice is `sending` with no transmission
 * that reached the PEC (outcome `none` everywhere) and its number is still the highest of its
 * year, so the sequence rolls back without leaving a gap. Anything else must be sent.
 */
export async function releaseNumber(db: D1Database, invoiceId: string): Promise<ReleaseResult> {
  const invoice = await db
    .prepare("SELECT state, number_int, series_id, year, planned_date FROM invoices WHERE id = ?")
    .bind(invoiceId)
    .first<{
      state: string;
      number_int: number | null;
      series_id: string;
      year: number | null;
      planned_date: string | null;
    }>();
  if (!invoice) throw makeError("not_found");
  if (invoice.number_int === null || invoice.year === null) {
    throw makeError("conflict", "not_numbered");
  }
  const { number_int: number, year, series_id: seriesId } = invoice;

  try {
    await db.batch([
      // 1. Guard: the sequence update gets NULL (NOT NULL) unless releasing is allowed.
      db
        .prepare(
          `UPDATE number_sequences SET last_number = CASE WHEN
             EXISTS (SELECT 1 FROM invoices WHERE id = ?1 AND state = 'sending' AND number_int = ?2 AND year = ?3)
             AND NOT EXISTS (SELECT 1 FROM transmissions WHERE invoice_id = ?1 AND send_outcome <> 'none')
             AND NOT EXISTS (SELECT 1 FROM invoices WHERE year = ?3 AND series_id = ?4 AND number_int > ?2)
           THEN ?2 - 1 ELSE NULL END
           WHERE year = ?3 AND series_id = ?4`,
        )
        .bind(invoiceId, number, year, seriesId),
      db.prepare("DELETE FROM transmissions WHERE invoice_id = ?").bind(invoiceId),
      db
        .prepare("DELETE FROM files WHERE invoice_id = ? AND kind IN ('xml', 'pdf')")
        .bind(invoiceId),
      db
        .prepare(
          `UPDATE invoices SET number_int = NULL, number_raw = NULL, year = NULL, issue_date = NULL,
             state = CASE WHEN planned_date IS NULL THEN 'draft' ELSE 'planned' END,
             state_rank = CASE WHEN planned_date IS NULL THEN 0 ELSE 1 END,
             updated_at = ?2
           WHERE id = ?1 AND state = 'sending'`,
        )
        .bind(invoiceId, Date.now()),
    ]);
  } catch {
    // The guard failed (the batch changed nothing): say why.
    const now_ = await db
      .prepare("SELECT state, number_int FROM invoices WHERE id = ?")
      .bind(invoiceId)
      .first<{ state: string; number_int: number | null }>();
    if (!now_) throw makeError("not_found");
    if (now_.number_int === null) throw makeError("conflict", "not_numbered");
    if (now_.state !== "sending") throw makeError("conflict", "number_not_releasable");
    const sent = await db
      .prepare("SELECT 1 AS hit FROM transmissions WHERE invoice_id = ? AND send_outcome <> 'none'")
      .bind(invoiceId)
      .first();
    if (sent) throw makeError("conflict", "number_not_releasable");
    throw makeError("conflict", "number_not_highest");
  }
  return {
    invoiceId,
    state: invoice.planned_date === null ? "draft" : "planned",
    number,
    year,
  };
}

export interface TransmissionAttempt {
  id: string;
  attempt: number;
  fileProgressive: number;
  fileName: string;
}

const RESENDABLE_STATES = "('sending', 'rejected')";

/**
 * Starts a new transmission attempt for an already numbered invoice (a resend after a rejection
 * or a retry of an unknown send): a new file progressive from `file_sequence` and a new file name,
 * while invoice number and issue date stay untouched. One guarded batch like the reservation: the
 * first statement fails (NOT NULL) when the invoice has no number or is not in a resendable state,
 * and then nothing is allocated. Whether a retry is allowed at all (quiet period, outcome checks)
 * is decided by the send flow before it calls this.
 */
export async function addTransmissionAttempt(
  db: D1Database,
  input: { invoiceId: string; now: Date; idPaese: string; idCodice: string },
): Promise<TransmissionAttempt> {
  const { invoiceId, idPaese, idCodice } = input;
  const id = crypto.randomUUID();
  const eligible = `EXISTS (SELECT 1 FROM invoices WHERE id = ?1 AND number_int IS NOT NULL
               AND state IN ${RESENDABLE_STATES})`;
  try {
    await db.batch([
      // 1. Allocate the progressive; the counter becomes NULL (NOT NULL) when the guard fails.
      db
        .prepare(
          `INSERT INTO file_sequence (id, last_value)
           VALUES (1, CASE WHEN ${eligible} THEN 1 ELSE NULL END)
           ON CONFLICT (id) DO UPDATE SET
             last_value = CASE WHEN ${eligible} THEN last_value + 1 ELSE NULL END`,
        )
        .bind(invoiceId),
      db
        .prepare(
          `INSERT INTO transmissions
             (id, invoice_id, attempt, file_progressive, file_name, channel, send_outcome, created_at)
           SELECT ?1, ?2,
                  COALESCE((SELECT MAX(attempt) FROM transmissions WHERE invoice_id = ?2), 0) + 1,
                  last_value, ?3 || ?4 || '_' || ${fileProgressiveSql("last_value")} || '.xml',
                  'pec', 'none', ?5
           FROM file_sequence WHERE id = 1`,
        )
        .bind(id, invoiceId, idPaese, idCodice, input.now.getTime()),
    ]);
  } catch (error) {
    const invoice = await db
      .prepare("SELECT state, number_int FROM invoices WHERE id = ?")
      .bind(invoiceId)
      .first<{ state: string; number_int: number | null }>();
    if (!invoice) throw makeError("not_found");
    if (invoice.number_int === null) throw makeError("conflict", "not_numbered");
    if (invoice.state !== "sending" && invoice.state !== "rejected") {
      throw makeError("conflict", "invoice_locked");
    }
    throw error;
  }
  const row = await db
    .prepare("SELECT id, attempt, file_progressive, file_name FROM transmissions WHERE id = ?")
    .bind(id)
    .first<{ id: string; attempt: number; file_progressive: number; file_name: string }>();
  if (!row) throw makeError("internal_error");
  return {
    id: row.id,
    attempt: row.attempt,
    fileProgressive: row.file_progressive,
    fileName: row.file_name,
  };
}
