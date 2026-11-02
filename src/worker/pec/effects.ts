import { INVOICE_STATES, type InvoiceState } from "../../shared/invoice-state";
import { isSdiAddress, normalizeMessageId, type SdiMessageType } from "../../shared/sdi-messages";
import { type NotificationType, outboxStatement } from "../outbox";
import type { Classification } from "./classify";

/**
 * What a stored message does to invoices, as statements for the message's D1 batch. Reads happen
 * here, before the batch; every write is guarded, so a stale read can only make a statement a
 * no-op: transitions never lower the state rank, only the latest attempt of an invoice moves it,
 * events are unique on their source and outbox rows on invoice + attempt + kind.
 */
export interface Plan {
  statements: D1PreparedStatement[];
  /** False for an SdI message no transmission claims: it stays listed as unmatched. */
  processed: boolean;
}

interface Match {
  transmissionId: string;
  invoiceId: string;
  attempt: number;
  outcome: "none" | "complete" | "unknown";
  state: string;
  number: string | null;
  year: number | null;
  latest: number;
}

const SELECT_MATCH = `
  SELECT t.id AS transmissionId, t.invoice_id AS invoiceId, t.attempt, t.send_outcome AS outcome,
         i.state, i.number_raw AS number, i.year,
         (SELECT MAX(x.attempt) FROM transmissions x WHERE x.invoice_id = t.invoice_id) AS latest
  FROM transmissions t JOIN invoices i ON i.id = t.invoice_id`;

/** The transmission a receipt belongs to: by the Message-ID we sent, else by invoice file name. */
async function matchTransmission(
  db: D1Database,
  refMessageId: string | null,
  fileNames: readonly (string | null)[],
): Promise<Match | null> {
  if (refMessageId) {
    const byId = await db
      .prepare(
        `${SELECT_MATCH} WHERE lower(replace(replace(t.channel_message_id, '<', ''), '>', '')) = ?`,
      )
      .bind(refMessageId)
      .first<Match>();
    if (byId) return byId;
  }
  for (const name of fileNames) {
    if (!name) continue;
    const byName = await db
      .prepare(`${SELECT_MATCH} WHERE lower(t.file_name) = lower(?)`)
      .bind(name)
      .first<Match>();
    if (byName) return byName;
  }
  return null;
}

const SDI_STATE: Partial<Record<SdiMessageType, InvoiceState>> = {
  RC: "delivered",
  MC: "not_delivered",
  NS: "rejected",
};

const SDI_NOTIFICATION: Partial<Record<InvoiceState, NotificationType>> = {
  delivered: "invoice_delivered",
  not_delivered: "invoice_not_delivered",
  rejected: "invoice_rejected",
};

/** Moves the invoice forward only, and only from its latest attempt. */
function transition(db: D1Database, m: Match, to: InvoiceState, now: number) {
  return db
    .prepare(
      `UPDATE invoices SET state = ?2, state_rank = ?3, updated_at = ?4
       WHERE id = ?1 AND state_rank < ?3
         AND (SELECT MAX(attempt) FROM transmissions WHERE invoice_id = ?1) = ?5`,
    )
    .bind(m.invoiceId, to, INVOICE_STATES.indexOf(to), now, m.attempt);
}

/** An attempt the mailbox shows was received moves from `unknown` to `complete`. */
const resolveUnknown = (db: D1Database, m: Match, now: number) =>
  db
    .prepare(
      "UPDATE transmissions SET send_outcome = 'complete', updated_at = ?2 WHERE id = ?1 AND send_outcome = 'unknown'",
    )
    .bind(m.transmissionId, now);

function eventStatement(
  db: D1Database,
  e: {
    sourceId: string;
    type: string;
    m: Match;
    payload: unknown;
    occurredAt: number;
  },
  now: number,
) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO events (id, source_id, type, invoice_id, transmission_id, payload,
         occurred_at, processed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      e.sourceId,
      e.type,
      e.m.invoiceId,
      e.m.transmissionId,
      JSON.stringify(e.payload),
      e.occurredAt,
      now,
      now,
    );
}

const numberOf = (m: Match) => (m.number ? (m.year ? `${m.number}/${m.year}` : m.number) : "");

async function sdiAddressOf(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT sdi_pec_address AS address FROM settings WHERE id = 1")
    .first<{ address: string | null }>();
  return row?.address ?? null;
}

export async function planEffects(
  db: D1Database,
  c: Classification,
  messageId: string,
  now = Date.now(),
): Promise<Plan> {
  const done: Plan = { statements: [], processed: true };
  const sourceId = `pec:${normalizeMessageId(messageId) ?? messageId}`;
  const occurredAt = c.sentAt ?? now;

  if (c.kind === "pec_receipt") {
    if (c.receipt === "other") return done;
    const m = await matchTransmission(db, c.refMessageId, c.fileNames);
    if (!m) return done;

    if (c.receipt === "acceptance") {
      return { statements: [resolveUnknown(db, m, now)], processed: true };
    }
    if (c.receipt === "delivery") {
      // Only the SdI mailbox's receipt means the invoice is out; a copy delivered elsewhere is not.
      const assigned = await sdiAddressOf(db);
      if (!c.recipients.some((address) => isSdiAddress(address, assigned))) return done;
      return {
        statements: [
          resolveUnknown(db, m, now),
          eventStatement(db, { sourceId, type: "PEC_DELIVERY", m, payload: {}, occurredAt }, now),
          transition(db, m, "sent", now),
        ],
        processed: true,
      };
    }
    // Non-delivery: nothing reached the SdI. The attempt is open again (same number and date, no
    // deadline) as long as it is the latest one and the invoice has not moved on.
    return {
      statements: [
        db
          .prepare(
            `UPDATE transmissions SET send_outcome = 'none', updated_at = ?2
             WHERE id = ?1 AND send_outcome IN ('unknown', 'complete')
               AND attempt = (SELECT MAX(attempt) FROM transmissions WHERE invoice_id = ?3)
               AND EXISTS (SELECT 1 FROM invoices WHERE id = ?3 AND state = 'sending')`,
          )
          .bind(m.transmissionId, now, m.invoiceId),
        eventStatement(
          db,
          { sourceId, type: "PEC_ERROR", m, payload: { reason: c.receipt }, occurredAt },
          now,
        ),
        outboxStatement(
          db,
          {
            invoiceId: m.invoiceId,
            attempt: m.attempt,
            kind: "notification",
            payload: { type: "pec_send_error", params: { number: numberOf(m) } },
            state: "sending",
          },
          now,
        ),
      ],
      processed: true,
    };
  }

  if (c.kind === "sdi_message") {
    const m = await matchTransmission(db, null, [c.fileName, c.receipt.fileName]);
    if (!m) return { statements: [], processed: false };
    const to = SDI_STATE[c.type];
    const payload =
      c.type === "NS"
        ? { errors: c.receipt.errors }
        : c.type === "MC"
          ? { description: c.receipt.description }
          : {};
    const statements = [
      // The SdI's first reply names the address for the next sends.
      db
        .prepare(
          `INSERT INTO settings (id, sdi_pec_address) VALUES (1, ?1)
           ON CONFLICT(id) DO UPDATE SET sdi_pec_address = COALESCE(sdi_pec_address, ?1)`,
        )
        .bind(c.sender),
      resolveUnknown(db, m, now),
      eventStatement(db, { sourceId, type: c.type, m, payload, occurredAt }, now),
    ];
    if (to) {
      statements.push(transition(db, m, to, now));
      const notification = SDI_NOTIFICATION[to];
      if (notification) {
        statements.push(
          outboxStatement(
            db,
            {
              invoiceId: m.invoiceId,
              attempt: m.attempt,
              kind: "notification",
              payload: { type: notification, params: { number: numberOf(m) } },
              state: to,
            },
            now,
          ),
        );
      }
      if (to === "delivered" || to === "not_delivered") {
        statements.push(
          outboxStatement(
            db,
            {
              invoiceId: m.invoiceId,
              attempt: m.attempt,
              kind: "email",
              payload: { reason: to },
              state: to,
            },
            now,
          ),
        );
      }
    }
    return { statements, processed: true };
  }

  return done;
}
