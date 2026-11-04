import { Hono } from "hono";
import { z } from "zod";
import type { SessionVariables } from "../auth/session";
import {
  type CourtesyDraft,
  composeDraft,
  loadCourtesyContext,
  loadEmailSettings,
  sendCourtesyEmail,
} from "../email/courtesy";
import { type Bindings, missingSecrets } from "../env";
import { makeError } from "../problem";
import { validationDetail } from "../validation";

export const courtesyEmail = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

interface LogRow {
  id: string;
  attempt: number | null;
  trigger: "automatic" | "ask" | "manual" | null;
  recipient: string;
  subject: string | null;
  messageId: string | null;
  status: "sent" | "failed";
  error: string | null;
  at: number;
}

interface AskRow {
  id: string;
  attempt: number;
}

async function askingOutbox(db: D1Database, invoiceId: string): Promise<AskRow | null> {
  return db
    .prepare(
      `SELECT id, attempt FROM outbox
       WHERE invoice_id = ? AND kind = 'email' AND status = 'asked'
       ORDER BY attempt DESC LIMIT 1`,
    )
    .bind(invoiceId)
    .first<AskRow>();
}

/**
 * The invoice's courtesy email: the draft as it would go out now, the pending "ask" offer if
 * any, whether sending is configured, and the `email_log` timeline (newest first).
 */
courtesyEmail.get("/:id/courtesy-email", async (c) => {
  const id = c.req.param("id");
  const settings = await loadEmailSettings(c.env);
  const ctx = await loadCourtesyContext(c.env.DB, id);
  const { results } = await c.env.DB.prepare(
    `SELECT id, attempt, trigger, recipient, subject, provider_message_id AS messageId, status,
            error, created_at AS at
     FROM email_log WHERE invoice_id = ? ORDER BY created_at DESC, id`,
  )
    .bind(id)
    .all<LogRow>();
  const draft: CourtesyDraft | null = ctx ? await composeDraft(c.env, ctx, settings) : null;
  return c.json({
    draft,
    ask: await askingOutbox(c.env.DB, id),
    ready: missingSecrets(c.env, "email").length === 0 && Boolean(settings.senderAddress),
    log: results,
  });
});

const sendBody = z.object({
  /** One id per click on Send: a retry of the same request never sends a second email. */
  requestId: z.string().min(8).max(64),
  to: z
    .string()
    .trim()
    .max(254)
    .regex(/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/, "invalid_email"),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20000),
  /** Set when the owner answers an "ask" offer. */
  outboxId: z.string().min(1).max(64).optional(),
});

/** Sends the (possibly edited) courtesy email: an answer to an "ask" offer or a manual send. */
courtesyEmail.post("/:id/courtesy-email", async (c) => {
  const id = c.req.param("id");
  const parsed = sendBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const input = parsed.data;
  let attempt: number | undefined;
  if (input.outboxId) {
    const ask = await askingOutbox(c.env.DB, id);
    if (!ask || ask.id !== input.outboxId) throw makeError("conflict", "not_asked");
    attempt = ask.attempt;
  }
  const ctx = await loadCourtesyContext(c.env.DB, id, attempt);
  if (!ctx) throw makeError("conflict", "no_pdf");
  const settings = await loadEmailSettings(c.env);
  if (!settings.senderAddress) throw makeError("conflict", "sender_missing");
  const result = await sendCourtesyEmail(c.env, {
    ctx,
    settings,
    trigger: input.outboxId ? "ask" : "manual",
    to: input.to,
    subject: input.subject,
    body: input.body,
    idempotencyKey: input.outboxId ? `outbox-${input.outboxId}` : `manual-${input.requestId}`,
    ...(input.outboxId ? { outboxId: input.outboxId } : {}),
  });
  if (!result.ok) throw makeError("email_failed", result.error);
  return c.json({ id: result.logId, messageId: result.messageId }, 201);
});

/** The owner declines an "ask" offer: nothing is sent and the card goes away. */
courtesyEmail.post("/:id/courtesy-email/skip", async (c) => {
  const id = c.req.param("id");
  const parsed = z
    .object({ outboxId: z.string().min(1).max(64) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const now = Date.now();
  const [skipped] = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE outbox SET status = 'skipped', error = 'skipped_by_owner', sent_at = ?3
       WHERE id = ?1 AND invoice_id = ?2 AND kind = 'email' AND status = 'asked'`,
    ).bind(parsed.data.outboxId, id, now),
    c.env.DB.prepare(
      `UPDATE notifications SET read_at = ?2
       WHERE invoice_id = ?1 AND type = 'courtesy_email_ask' AND read_at IS NULL`,
    ).bind(id, now),
  ]);
  if (!skipped?.meta.changes) throw makeError("conflict", "not_asked");
  return c.body(null, 204);
});
