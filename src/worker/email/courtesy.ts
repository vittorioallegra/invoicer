import { renderCourtesyEmail } from "../../shared/courtesy-email";
import { type InvoiceLanguage, invoiceDataSchema } from "../../shared/invoice";
import { invoicePdfFileName } from "../../shared/pdf-name";
import { type Bindings, requireSecrets } from "../env";
import { notificationTitleKey } from "../outbox";
import { createD1FileStorage } from "../storage";
import { EmailSendError, sendWithResend } from "./resend";

export type EmailTrigger = "automatic" | "ask" | "manual";

export interface EmailSettings {
  senderName: string | null;
  senderAddress: string | null;
  replyTo: string | null;
  bcc: string | null;
  mode: "automatic" | "ask" | "off";
  configuredAt: number | null;
  profileName: string | null;
}

export async function loadEmailSettings(env: Bindings): Promise<EmailSettings> {
  const row = await env.DB.prepare(
    `SELECT s.email_sender_name AS senderName, s.email_sender_address AS senderAddress,
            s.email_reply_to AS replyTo, s.email_bcc AS bcc, s.courtesy_email_mode AS mode,
            s.email_configured_at AS configuredAt
     FROM settings s WHERE s.id = 1`,
  ).first<Omit<EmailSettings, "profileName" | "mode"> & { mode: EmailSettings["mode"] | null }>();
  const profile = await env.DB.prepare("SELECT name FROM profile WHERE id = 1").first<{
    name: string;
  }>();
  return {
    senderName: row?.senderName || null,
    senderAddress: row?.senderAddress || env.MAIL_FROM_ADDRESS || null,
    replyTo: row?.replyTo || null,
    bcc: row?.bcc || null,
    mode: row?.mode ?? "ask",
    configuredAt: row?.configuredAt ?? null,
    profileName: profile?.name ?? null,
  };
}

/** What the invoice's email is made from; null when the invoice has nothing to attach yet. */
export interface CourtesyContext {
  invoiceId: string;
  state: string;
  number: string;
  creditNote: boolean;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  totalCents: number;
  clientName: string;
  clientEmail: string | null;
  language: InvoiceLanguage;
  /** The attempt whose PDF and XML are attached. */
  attempt: number;
  xmlFileId: string | null;
  pdfFileId: string;
}

interface ContextRow {
  state: string;
  number: string | null;
  documentType: string;
  issueDate: string | null;
  plannedDate: string | null;
  dueDate: string | null;
  currency: string;
  totalCents: number | null;
  data: string | null;
  source: string;
  clientName: string | null;
  clientEmail: string | null;
  clientLanguage: InvoiceLanguage | null;
}

/**
 * Loads the invoice for a courtesy email with the files of one transmission attempt (`attempt`
 * given: that attempt, as the outbox row asks; else the latest attempt that has a stored PDF).
 */
export async function loadCourtesyContext(
  db: D1Database,
  invoiceId: string,
  attempt?: number,
): Promise<CourtesyContext | null> {
  const row = await db
    .prepare(
      `SELECT i.state AS state, i.number_raw AS number, i.document_type AS documentType,
              i.issue_date AS issueDate, i.planned_date AS plannedDate, i.due_date AS dueDate,
              i.currency AS currency, i.total_cents AS totalCents, i.data AS data,
              i.source AS source, c.name AS clientName, c.email AS clientEmail,
              c.pdf_language AS clientLanguage
       FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.id = ?`,
    )
    .bind(invoiceId)
    .first<ContextRow>();
  if (row?.source !== "app" || !row.number) return null;
  const transmission = await db
    .prepare(
      `SELECT attempt, xml_file_id AS xmlFileId, pdf_file_id AS pdfFileId FROM transmissions
       WHERE invoice_id = ?1 AND pdf_file_id IS NOT NULL AND (?2 IS NULL OR attempt = ?2)
       ORDER BY attempt DESC LIMIT 1`,
    )
    .bind(invoiceId, attempt ?? null)
    .first<{ attempt: number; xmlFileId: string | null; pdfFileId: string }>();
  if (!transmission) return null;
  const data = invoiceDataSchema.safeParse(row.data ? JSON.parse(row.data) : null);
  return {
    invoiceId,
    state: row.state,
    number: row.number,
    creditNote: row.documentType === "TD04",
    issueDate: row.issueDate ?? row.plannedDate ?? "",
    dueDate: row.dueDate,
    currency: row.currency,
    totalCents: row.totalCents ?? 0,
    clientName: row.clientName ?? "",
    clientEmail: row.clientEmail?.trim() || null,
    language: (data.success ? data.data.language : null) ?? row.clientLanguage ?? "it",
    attempt: transmission.attempt,
    xmlFileId: transmission.xmlFileId,
    pdfFileId: transmission.pdfFileId,
  };
}

export interface CourtesyDraft {
  to: string;
  subject: string;
  body: string;
  from: string | null;
  replyTo: string | null;
  bcc: string | null;
  attachments: { filename: string; size: number }[];
}

export function senderDisplayName(settings: EmailSettings): string {
  return settings.senderName ?? settings.profileName ?? "";
}

/** The email as it would go out now: template in the invoice's language, recipient, attachments. */
export async function composeDraft(
  env: Bindings,
  ctx: CourtesyContext,
  settings: EmailSettings,
): Promise<CourtesyDraft> {
  const sender = senderDisplayName(settings);
  const { subject, body } = renderCourtesyEmail(ctx.language, {
    client: ctx.clientName,
    sender,
    number: ctx.number,
    date: ctx.issueDate,
    dueDate: ctx.dueDate,
    totalCents: ctx.totalCents,
    currency: ctx.currency,
    creditNote: ctx.creditNote,
    notDelivered: ctx.state === "not_delivered",
  });
  const { results } = await env.DB.prepare(
    "SELECT kind, filename, size FROM files WHERE id IN (?1, ?2)",
  )
    .bind(ctx.pdfFileId, ctx.xmlFileId ?? ctx.pdfFileId)
    .all<{ kind: string; filename: string; size: number }>();
  return {
    to: ctx.clientEmail ?? "",
    subject,
    body,
    from: settings.senderAddress ? fromHeader(sender, settings.senderAddress) : null,
    replyTo: settings.replyTo,
    bcc: settings.bcc,
    attachments: results
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "pdf" ? -1 : 1))
      .map((f) => ({
        filename: f.kind === "pdf" ? invoicePdfFileName(ctx.number, ctx.clientName) : f.filename,
        size: f.size,
      })),
  };
}

function fromHeader(name: string, address: string): string {
  const clean = name.replace(/["\\\r\n<>]/g, "").trim();
  return clean ? `"${clean}" <${address}>` : address;
}

export interface SendRequest {
  ctx: CourtesyContext;
  settings: EmailSettings;
  trigger: EmailTrigger;
  to: string;
  subject: string;
  body: string;
  idempotencyKey: string;
  /** The outbox row this send settles (automatic and ask); manual sends have none. */
  outboxId?: string;
}

export type SendResult =
  | { ok: true; logId: string; messageId: string }
  | { ok: false; logId: string; error: string };

/**
 * Sends the courtesy email and records it: the `email_log` row and the outbox settlement go in
 * one batch, so a crash after Resend accepted the call leaves the outbox row open and the retry
 * (same Idempotency-Key) returns the same message instead of sending a second one. A failure
 * writes a failed log row and the `courtesy_email_failed` notification; it is never retried
 * automatically, the owner resends by hand. A missing `RESEND_API_KEY` throws (nothing recorded).
 */
export async function sendCourtesyEmail(
  env: Bindings,
  req: SendRequest,
  now = Date.now(),
): Promise<SendResult> {
  const { ctx, settings } = req;
  requireSecrets(env, "email");
  const logId = crypto.randomUUID();
  const settle = (status: "sent" | "failed", error: string | null) =>
    req.outboxId
      ? [
          env.DB.prepare(
            `UPDATE outbox SET status = ?2, error = ?3, sent_at = ?4
             WHERE id = ?1 AND status IN ('pending', 'asked')`,
          ).bind(req.outboxId, status, error, now),
        ]
      : [];
  const logStatement = (
    status: "sent" | "failed",
    messageId: string | null,
    error: string | null,
  ) =>
    env.DB.prepare(
      `INSERT INTO email_log (id, invoice_id, attempt, trigger, recipient, subject,
         provider_message_id, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      logId,
      ctx.invoiceId,
      ctx.attempt,
      req.trigger,
      req.to,
      req.subject,
      messageId,
      status,
      error,
      now,
    );
  const closeAsk = env.DB.prepare(
    `UPDATE notifications SET read_at = ?2
     WHERE invoice_id = ?1 AND type = 'courtesy_email_ask' AND read_at IS NULL`,
  ).bind(ctx.invoiceId, now);

  try {
    if (!settings.senderAddress) throw new EmailSendError("sender_missing");
    const storage = createD1FileStorage(env.DB);
    const pdf = await storage.get(ctx.pdfFileId);
    if (!pdf) throw new EmailSendError("pdf_missing");
    const attachments = [
      { filename: invoicePdfFileName(ctx.number, ctx.clientName), content: pdf.content },
    ];
    if (ctx.xmlFileId) {
      const xml = await storage.get(ctx.xmlFileId);
      if (xml) attachments.push({ filename: xml.filename, content: xml.content });
    }
    const sent = await sendWithResend(
      env,
      {
        from: fromHeader(senderDisplayName(settings), settings.senderAddress),
        to: [req.to],
        bcc: settings.bcc ? [settings.bcc] : [],
        replyTo: settings.replyTo,
        subject: req.subject,
        text: req.body,
        attachments,
      },
      req.idempotencyKey,
    );
    await env.DB.batch([logStatement("sent", sent.id, null), ...settle("sent", null), closeAsk]);
    return { ok: true, logId, messageId: sent.id };
  } catch (error) {
    if (!(error instanceof EmailSendError)) throw error;
    await env.DB.batch([
      logStatement("failed", null, error.code),
      ...settle("failed", error.code),
      env.DB.prepare(
        `INSERT INTO notifications (id, type, title, body, invoice_id, created_at)
         VALUES (?, 'courtesy_email_failed', ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        notificationTitleKey("courtesy_email_failed"),
        JSON.stringify({ number: ctx.number, client: ctx.clientName, recipient: req.to }),
        ctx.invoiceId,
        now,
      ),
    ]);
    return { ok: false, logId, error: error.code };
  }
}
