import type { AttemptState } from "../../shared/channel/quiet-period";
import { INVOICE_STATES, type InvoiceState } from "../../shared/invoice-state";

export interface TransmissionRow {
  id: string;
  attempt: number;
  fileName: string;
  channel: "pec" | "manual";
  outcome: "none" | "complete" | "unknown";
  messageId: string | null;
  sdiPecAddress: string | null;
  xmlFileId: string | null;
  pdfFileId: string | null;
  createdAt: number;
  /** When the send of this attempt started (the claim), else when the attempt was created. */
  startedAt: number;
}

interface Raw {
  id: string;
  attempt: number;
  file_name: string;
  channel: "pec" | "manual";
  send_outcome: "none" | "complete" | "unknown";
  channel_message_id: string | null;
  sdi_pec_address: string | null;
  xml_file_id: string | null;
  pdf_file_id: string | null;
  created_at: number;
  updated_at: number | null;
}

const toRow = (r: Raw): TransmissionRow => ({
  id: r.id,
  attempt: r.attempt,
  fileName: r.file_name,
  channel: r.channel,
  outcome: r.send_outcome,
  messageId: r.channel_message_id,
  sdiPecAddress: r.sdi_pec_address,
  xmlFileId: r.xml_file_id,
  pdfFileId: r.pdf_file_id,
  createdAt: r.created_at,
  startedAt: r.updated_at ?? r.created_at,
});

/** Every attempt of the invoice, oldest first. */
export async function listTransmissions(
  db: D1Database,
  invoiceId: string,
): Promise<TransmissionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, attempt, file_name, channel, send_outcome, channel_message_id, sdi_pec_address,
              xml_file_id, pdf_file_id, created_at, updated_at
       FROM transmissions WHERE invoice_id = ? ORDER BY attempt ASC`,
    )
    .bind(invoiceId)
    .all<Raw>();
  return results.map(toRow);
}

export const asAttemptState = (row: TransmissionRow): AttemptState => ({
  outcome: row.outcome,
  startedAt: row.startedAt,
});

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Moves an invoice forward only (guarded on the state rank), so replays never go backwards. */
export async function advanceState(
  db: D1Database,
  invoiceId: string,
  to: InvoiceState,
  now = Date.now(),
): Promise<boolean> {
  const rank = INVOICE_STATES.indexOf(to);
  const result = await db
    .prepare(
      `UPDATE invoices SET state = ?2, state_rank = ?3, updated_at = ?4
       WHERE id = ?1 AND state_rank < ?3`,
    )
    .bind(invoiceId, to, rank, now)
    .run();
  return result.meta.changes > 0;
}
