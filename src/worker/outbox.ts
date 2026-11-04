import type { NotificationType } from "../shared/notifications";
import type { Bindings } from "./env";

export type { NotificationType };

export type NotificationParams = Record<string, string | number>;

export interface NotificationPayload {
  type: NotificationType;
  params: NotificationParams;
}

export const notificationTitleKey = (type: NotificationType) => `notifications.${type}.title`;

/**
 * A notification row without an invoice (mailbox problems, received invoices). With
 * `unlessUnread` it is skipped while an unread notification of the same type and values exists,
 * so a problem that repeats on every cron tick raises one notification, not one per tick.
 */
export function notificationStatement(
  db: D1Database,
  type: NotificationType,
  params: NotificationParams,
  now = Date.now(),
  options: { unlessUnread?: boolean } = {},
): D1PreparedStatement {
  const body = JSON.stringify(params);
  return db
    .prepare(
      `INSERT INTO notifications (id, type, title, body, invoice_id, created_at)
       SELECT ?1, ?2, ?3, ?4, NULL, ?5
       WHERE ?6 = 0 OR NOT EXISTS (
         SELECT 1 FROM notifications WHERE type = ?2 AND body = ?4 AND read_at IS NULL)`,
    )
    .bind(
      crypto.randomUUID(),
      type,
      notificationTitleKey(type),
      body,
      now,
      options.unlessUnread ? 1 : 0,
    );
}

/**
 * An outbox row for a state change, inserted in the same batch. It is created only when the
 * invoice is in `state` (the guarded transition applied) and this is its latest attempt, and is unique per invoice, attempt and
 * kind, so a replayed message never queues a second side effect.
 */
export function outboxStatement(
  db: D1Database,
  row: {
    invoiceId: string;
    attempt: number;
    kind: "notification" | "email";
    payload: unknown;
    state: string;
  },
  now = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO outbox (id, invoice_id, attempt, kind, payload, status, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6
       WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ?2 AND state = ?7)
         AND ?3 = (SELECT MAX(attempt) FROM transmissions WHERE invoice_id = ?2)`,
    )
    .bind(
      crypto.randomUUID(),
      row.invoiceId,
      row.attempt,
      row.kind,
      JSON.stringify(row.payload),
      now,
      row.state,
    );
}

const BATCH_SIZE = 25;

/**
 * Delivers pending in-app notifications: the notification row and the outbox status change in
 * one batch, so a crash leaves the row pending and the next cron run retries it. `email` rows
 * are delivered by `processEmailOutbox` (`email/deliver.ts`); pushes are derived from the delivered
 * notification rows by `processPushNotifications` (`push/deliver.ts`), not queued here.
 * Returns how many rows were delivered.
 */
export async function processOutbox(env: Bindings, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, invoice_id AS invoiceId, payload FROM outbox
     WHERE status = 'pending' AND kind = 'notification' ORDER BY created_at LIMIT ?`,
  )
    .bind(BATCH_SIZE)
    .all<{ id: string; invoiceId: string; payload: string | null }>();
  let delivered = 0;
  for (const row of results) {
    try {
      const payload = JSON.parse(row.payload ?? "null") as NotificationPayload | null;
      if (!payload?.type) throw new Error("bad_payload");
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO notifications (id, type, title, body, invoice_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          payload.type,
          notificationTitleKey(payload.type),
          JSON.stringify(payload.params ?? {}),
          row.invoiceId,
          now,
        ),
        env.DB.prepare(
          "UPDATE outbox SET status = 'sent', sent_at = ?2, error = NULL WHERE id = ?1 AND status = 'pending'",
        ).bind(row.id, now),
      ]);
      delivered += 1;
    } catch (error) {
      // Stay pending: the next cron run retries. Only the error name is kept, never a message.
      await env.DB.prepare("UPDATE outbox SET error = ?2 WHERE id = ?1")
        .bind(row.id, error instanceof Error ? error.name : "error")
        .run()
        .catch(() => undefined);
    }
  }
  return delivered;
}
