import { romeDateTime } from "../../shared/cron";
import { formatNumberWithYear } from "../../shared/numbering";
import type { Bindings } from "../env";
import { overdueCondition } from "../invoices/store";
import { notificationTitleKey } from "../outbox";

/** Most notifications one daily run writes; a larger backlog is worked off over the next days. */
export const OVERDUE_MAX_PER_RUN = 50;

/**
 * Daily job: one notification for every invoice issued from the app that is past its due date
 * and still unpaid (the same rule as the Home count and the overdue list filter). An invoice is
 * announced once, the first day it is found overdue; marking it paid or looking at the list does
 * not need another reminder. Imported historic invoices are left out (they are read-only
 * records, often settled long ago). Idempotent: a row for the invoice is never written twice.
 * Returns how many were created.
 */
export async function notifyOverdueInvoices(env: Bindings, now = new Date()): Promise<number> {
  const today = romeDateTime(now).date;
  const type = "invoice_overdue";
  const { results } = await env.DB.prepare(
    `SELECT i.id AS id, i.number_raw AS number, i.year AS year, i.due_date AS dueDate, c.name AS client
     FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
     WHERE ${overdueCondition("?1")} AND i.source = 'app'
       AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.type = ?2 AND n.invoice_id = i.id)
     ORDER BY i.due_date, i.id LIMIT ?3`,
  )
    .bind(today, type, OVERDUE_MAX_PER_RUN)
    .all<{
      id: string;
      number: string | null;
      year: number | null;
      dueDate: string;
      client: string | null;
    }>();
  if (results.length === 0) return 0;
  const written = await env.DB.batch(
    results.map((row) =>
      env.DB.prepare(
        `INSERT INTO notifications (id, type, title, body, invoice_id, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE type = ?2 AND invoice_id = ?5)`,
      ).bind(
        crypto.randomUUID(),
        type,
        notificationTitleKey(type),
        JSON.stringify({
          number: row.number ? formatNumberWithYear(row.number, row.year) : "",
          client: row.client ?? "",
          dueDate: row.dueDate,
        }),
        row.id,
        now.getTime(),
      ),
    ),
  );
  return written.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
}
