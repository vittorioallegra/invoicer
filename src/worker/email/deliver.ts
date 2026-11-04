import type { Bindings } from "../env";
import { notificationTitleKey } from "../outbox";
import {
  composeDraft,
  type EmailSettings,
  loadCourtesyContext,
  loadEmailSettings,
  sendCourtesyEmail,
} from "./courtesy";

/** Emails sent per run: each one reads the stored files and encodes them (10 ms CPU budget). */
const EMAIL_BATCH_SIZE = 3;

type SkipReason = "off" | "not_configured" | "before_enabled" | "no_recipient" | "no_files";

function skip(db: D1Database, id: string, reason: SkipReason, now: number) {
  return db
    .prepare(
      `UPDATE outbox SET status = 'skipped', error = ?2, sent_at = ?3
       WHERE id = ?1 AND status = 'pending'`,
    )
    .bind(id, reason, now);
}

/** Why a queued email is not sent at all (rows are marked skipped, never retried), else null. */
function notSendable(env: Bindings, settings: EmailSettings, createdAt: number): SkipReason | null {
  if (!settings.configuredAt || !env.RESEND_API_KEY || !settings.senderAddress) {
    return "not_configured";
  }
  if (settings.mode === "off") return "off";
  // Rows queued before the courtesy email was configured or last changed are not sent late.
  if (createdAt < settings.configuredAt) return "before_enabled";
  return null;
}

/**
 * Settles the `email` outbox rows polling queued (delivered / not_delivered, one per invoice and
 * attempt). Off, not configured, queued before it was enabled, or no recipient: marked skipped.
 * Mode `ask`: the row waits as `asked` and an in-app notification opens the preview. Mode
 * `automatic`: sent now, with the outbox row id as the Resend Idempotency-Key. A row whose send
 * crashed stays pending and is retried with the same key on the next tick. Returns how many
 * rows were settled.
 */
export async function processEmailOutbox(env: Bindings, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, invoice_id AS invoiceId, attempt, created_at AS createdAt FROM outbox
     WHERE status = 'pending' AND kind = 'email' ORDER BY created_at LIMIT ?`,
  )
    .bind(EMAIL_BATCH_SIZE)
    .all<{ id: string; invoiceId: string; attempt: number; createdAt: number }>();
  if (results.length === 0) return 0;
  const settings = await loadEmailSettings(env);
  let settled = 0;
  for (const row of results) {
    try {
      const reason = notSendable(env, settings, row.createdAt);
      if (reason) {
        await skip(env.DB, row.id, reason, now).run();
        settled += 1;
        continue;
      }
      const ctx = await loadCourtesyContext(env.DB, row.invoiceId, row.attempt);
      if (!ctx) {
        await skip(env.DB, row.id, "no_files", now).run();
        settled += 1;
        continue;
      }
      const draft = await composeDraft(env, ctx, settings);
      if (!draft.to) {
        await skip(env.DB, row.id, "no_recipient", now).run();
        settled += 1;
        continue;
      }
      if (settings.mode === "ask") {
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE outbox SET status = 'asked' WHERE id = ?1 AND status = 'pending'",
          ).bind(row.id),
          env.DB.prepare(
            `INSERT INTO notifications (id, type, title, body, invoice_id, created_at)
             VALUES (?, 'courtesy_email_ask', ?, ?, ?, ?)`,
          ).bind(
            crypto.randomUUID(),
            notificationTitleKey("courtesy_email_ask"),
            JSON.stringify({ number: ctx.number, client: ctx.clientName }),
            row.invoiceId,
            now,
          ),
        ]);
      } else {
        await sendCourtesyEmail(
          env,
          {
            ctx,
            settings,
            trigger: "automatic",
            to: draft.to,
            subject: draft.subject,
            body: draft.body,
            idempotencyKey: `outbox-${row.id}`,
            outboxId: row.id,
          },
          now,
        );
      }
      settled += 1;
    } catch (error) {
      // Stay pending: the next tick retries. Only the error name is kept, never a message.
      await env.DB.prepare("UPDATE outbox SET error = ?2 WHERE id = ?1")
        .bind(row.id, error instanceof Error ? error.name : "error")
        .run()
        .catch(() => undefined);
    }
  }
  return settled;
}
