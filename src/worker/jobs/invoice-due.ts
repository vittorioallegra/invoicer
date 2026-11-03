import { romeDateTime } from "../../shared/cron";
import type { Bindings } from "../env";
import { notificationTitleKey } from "../outbox";

/** How many days after its date a still unsent invoice keeps being reminded about. */
export const INVOICE_DUE_REMINDER_DAYS = 14;

/** `YYYY-MM-DD` shifted by whole days (calendar arithmetic, no time zone involved). */
function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Daily job: a notification for every saved invoice that has not been sent although its invoice
 * date has been reached (Europe/Rome), one per invoice per day, until it is sent, deleted, or
 * `INVOICE_DUE_REMINDER_DAYS` days have passed. Idempotent: the day is part of the notification
 * body and a row for the same invoice and day is never written twice. Returns how many were
 * created.
 */
export async function remindUnsentInvoices(env: Bindings, now = new Date()): Promise<number> {
  const today = romeDateTime(now).date;
  const since = shiftDate(today, -INVOICE_DUE_REMINDER_DAYS);
  const { results } = await env.DB.prepare(
    `SELECT i.id AS id, i.planned_date AS date, c.name AS client
     FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
     WHERE i.state IN ('draft', 'planned') AND i.planned_date IS NOT NULL
       AND i.planned_date <= ?1 AND i.planned_date >= ?2`,
  )
    .bind(today, since)
    .all<{ id: string; date: string; client: string | null }>();

  const type = "invoice_due";
  const statements = results.map((row) =>
    env.DB.prepare(
      `INSERT INTO notifications (id, type, title, body, invoice_id, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE NOT EXISTS (
         SELECT 1 FROM notifications
         WHERE type = ?2 AND invoice_id = ?5 AND json_extract(body, '$.day') = ?7)`,
    ).bind(
      crypto.randomUUID(),
      type,
      notificationTitleKey(type),
      JSON.stringify({ client: row.client ?? "", date: row.date, day: today }),
      row.id,
      now.getTime(),
      today,
    ),
  );
  if (statements.length === 0) return 0;
  const written = await env.DB.batch(statements);
  return written.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
}
