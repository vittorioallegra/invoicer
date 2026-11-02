import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../../db/schema";
import { retryDecision } from "../../shared/channel/quiet-period";
import { sdiAddressFor } from "../../shared/channel/sdi-address";
import { ChannelError, type ChannelErrorCode } from "../../shared/channel/types";
import type { ErrorCode } from "../../shared/errors";
import { REJECTION_EVENT_TYPE, rejectionDeadline } from "../../shared/invoice";
import { INVOICE_STATES } from "../../shared/invoice-state";
import {
  type SendAnswer,
  sendAnswerSchema,
  sendRefusedError,
  verifySendAuthorization,
} from "../auth/send-authorization";
import type { SessionVariables } from "../auth/session";
import { channelDeps } from "../channel";
import { type Bindings, isMockChannel } from "../env";
import { addTransmissionAttempt } from "../invoices/numbering";
import {
  advanceState,
  asAttemptState,
  listTransmissions,
  sha256Hex,
  type TransmissionRow,
} from "../invoices/transmissions";
import { lastSuccessfulPollAt } from "../jobs/job-runs";
import { loadSendReadiness } from "../onboarding";
import { loadPecServers } from "../pec/config";
import { makeError } from "../problem";
import { createD1FileStorage } from "../storage";
import { validationDetail } from "../validation";

export const send = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

const CHANNEL_ERROR_TO_API: Record<ChannelErrorCode, ErrorCode> = {
  auth_failed: "pec_auth_failed",
  mailbox_full: "pec_mailbox_full",
  sdi_address_missing: "pec_sdi_address_missing",
  unavailable: "pec_unavailable",
  rejected: "pec_rejected",
  unknown_outcome: "send_outcome_unknown",
};

interface InvoiceRow {
  state: string;
  number_int: number | null;
  number_raw: string | null;
}

async function loadRow(db: D1Database, id: string): Promise<InvoiceRow> {
  const row = await db
    .prepare("SELECT state, number_int, number_raw FROM invoices WHERE id = ?")
    .bind(id)
    .first<InvoiceRow>();
  if (!row) throw makeError("not_found");
  return row;
}

async function currentTransmission(db: D1Database, invoiceId: string): Promise<TransmissionRow> {
  const all = await listTransmissions(db, invoiceId);
  const latest = all.at(-1);
  if (!latest) throw makeError("conflict", "not_numbered");
  return latest;
}

/** What the detail page needs: every attempt and whether, and how, a new send may start. */
send.get("/:id/transmissions", async (c) => {
  const id = c.req.param("id");
  const invoice = await loadRow(c.env.DB, id);
  const attempts = await listTransmissions(c.env.DB, id);
  const now = Date.now();
  const decision =
    invoice.state === "sending"
      ? retryDecision(attempts.map(asAttemptState), now, await lastSuccessfulPollAt(c.env.DB))
      : invoice.state === "rejected"
        ? ({ allowed: true, mode: "new_attempt" } as const)
        : ({ allowed: false, reason: "not_sendable" } as const);
  return c.json({
    attempts: attempts.map((a) => ({
      id: a.id,
      attempt: a.attempt,
      fileName: a.fileName,
      channel: a.channel,
      outcome: a.outcome,
      sdiPecAddress: a.sdiPecAddress,
      hasXml: a.xmlFileId !== null,
      hasPdf: a.pdfFileId !== null,
      startedAt: a.startedAt,
    })),
    retry: decision,
  });
});

/** The ProgressivoInvio must be the file name's progressive: the SdI echoes the file name. */
function xmlMatches(xml: string, fileName: string): boolean {
  const progressive = /_([A-Za-z0-9]+)\.xml$/i.exec(fileName)?.[1];
  return (
    /^﻿?\s*<\?xml/.test(xml) &&
    xml.includes("FatturaElettronica") &&
    Boolean(progressive) &&
    xml.includes(`<ProgressivoInvio>${progressive}</ProgressivoInvio>`)
  );
}

/** Stores the final XML the browser built for the current attempt (replaces an earlier one). */
send.put("/:id/xml", async (c) => {
  const id = c.req.param("id");
  const length = Number(c.req.header("Content-Length") ?? 0);
  if (length > schema.MAX_FILE_BYTES) throw makeError("payload_too_large");
  const content = new Uint8Array(await c.req.arrayBuffer());
  const invoice = await loadRow(c.env.DB, id);
  if (invoice.state !== "sending") throw makeError("conflict", "invoice_locked");
  const current = await currentTransmission(c.env.DB, id);
  if (current.outcome !== "none") throw makeError("conflict", "transmission_sent");
  if (!xmlMatches(new TextDecoder().decode(content), current.fileName)) {
    throw makeError("bad_request", "body: not_the_invoice_xml");
  }
  const storage = createD1FileStorage(c.env.DB);
  const stored = await storage.put({
    kind: "xml",
    filename: current.fileName,
    contentType: "application/xml",
    content,
    invoiceId: id,
    transmissionId: current.id,
  });
  await c.env.DB.prepare("UPDATE transmissions SET xml_file_id = ?, updated_at = ? WHERE id = ?")
    .bind(stored.id, Date.now(), current.id)
    .run();
  if (current.xmlFileId) await storage.delete(current.xmlFileId);
  return c.json(
    {
      file: {
        id: stored.id,
        filename: current.fileName,
        size: stored.size,
        sha256: stored.sha256,
        transmissionId: current.id,
        attempt: current.attempt,
      },
    },
    201,
  );
});

/** The latest stored XML as a download. */
send.get("/:id/xml", async (c) => {
  const rows = (await listTransmissions(c.env.DB, c.req.param("id"))).filter((r) => r.xmlFileId);
  const latest = rows.at(-1);
  const file = latest?.xmlFileId ? await createD1FileStorage(c.env.DB).get(latest.xmlFileId) : null;
  if (!file) throw makeError("not_found");
  return new Response(file.content, {
    headers: {
      "Content-Type": "application/xml",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Content-Length": String(file.size),
      "Cache-Control": "private, no-store",
    },
  });
});

/**
 * Starts the next attempt. After an SdI rejection (within the 5-day window) or an unknown outcome
 * past the quiet period it allocates a new file progressive; after a definite refusal the same
 * attempt is simply tried again. Number and issue date never change.
 */
send.post("/:id/new-attempt", async (c) => {
  const id = c.req.param("id");
  const invoice = await loadRow(c.env.DB, id);
  const attempts = await listTransmissions(c.env.DB, id);
  const now = Date.now();
  let allocate = false;
  if (invoice.state === "rejected") {
    const event = await c.env.DB.prepare(
      `SELECT occurred_at FROM events WHERE invoice_id = ? AND type = ? AND occurred_at IS NOT NULL
       ORDER BY occurred_at DESC LIMIT 1`,
    )
      .bind(id, REJECTION_EVENT_TYPE)
      .first<{ occurred_at: number }>();
    if (event && now > rejectionDeadline(event.occurred_at)) {
      throw makeError("conflict", "rejection_window_expired");
    }
    allocate = true;
  } else if (invoice.state === "sending") {
    const decision = retryDecision(
      attempts.map(asAttemptState),
      now,
      await lastSuccessfulPollAt(c.env.DB),
    );
    if (!decision.allowed) {
      throw makeError(
        "conflict",
        decision.reason === "quiet_period"
          ? `quiet_period (retry at ${decision.retryAt})`
          : decision.reason,
      );
    }
    allocate = decision.mode === "new_attempt";
  } else {
    throw makeError("conflict", "invoice_locked");
  }

  if (allocate) {
    const profile = await drizzle(c.env.DB, { schema })
      .select({ country: schema.profile.country, vatNumber: schema.profile.vatNumber })
      .from(schema.profile)
      .where(eq(schema.profile.id, 1))
      .get();
    if (!profile) throw makeError("conflict", "send: not_ready (profile_incomplete)");
    await addTransmissionAttempt(c.env.DB, {
      invoiceId: id,
      now: new Date(now),
      idPaese: profile.country,
      idCodice: profile.vatNumber,
    });
    if (invoice.state === "rejected") {
      await c.env.DB.prepare(
        `UPDATE invoices SET state = 'sending', state_rank = 2, updated_at = ?2
         WHERE id = ?1 AND state = 'rejected'`,
      )
        .bind(id, now)
        .run();
    }
  }
  const current = await currentTransmission(c.env.DB, id);
  return c.json({
    transmission: { id: current.id, attempt: current.attempt, fileName: current.fileName },
  });
});

const sendBody = z.object({ answer: sendAnswerSchema });

function sendFailure(error: unknown) {
  if (error instanceof ChannelError) {
    return makeError(CHANNEL_ERROR_TO_API[error.code], error.code);
  }
  return makeError("send_outcome_unknown", "unknown_outcome");
}

function messageIdFor(username: string | undefined): string {
  const domain = username?.split("@").pop() || "invoicer.local";
  return `<${crypto.randomUUID()}@${domain}>`;
}

/**
 * Sends the stored final XML. Order matters: the XML hash is computed here from the stored file
 * (never taken from the browser), the passkey/TOTP assertion bound to that hash is verified, and
 * only then is the channel created, so no SMTP socket exists before the assertion is valid.
 * Before the SMTP session the attempt is claimed as `unknown` with its Message-ID, so a crash at
 * any point afterwards leaves a state the mailbox polling resolves; a definite refusal puts it
 * back to `none`.
 */
send.post("/:id/send", async (c) => {
  const id = c.req.param("id");
  const parsed = sendBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const answer: SendAnswer = parsed.data.answer;

  const invoice = await loadRow(c.env.DB, id);
  if (invoice.state !== "sending") throw makeError("conflict", "invoice_not_sendable");
  const current = await currentTransmission(c.env.DB, id);
  if (current.outcome !== "none") {
    throw makeError(
      "conflict",
      current.outcome === "complete" ? "already_sent" : "outcome_unknown",
    );
  }
  if (!current.xmlFileId) throw makeError("conflict", "xml_missing");
  const readiness = await loadSendReadiness(c.env);
  if (!readiness.ready) {
    throw makeError("conflict", `send: not_ready (${readiness.reasons.join(", ")})`);
  }

  const storage = createD1FileStorage(c.env.DB);
  const xml = await storage.get(current.xmlFileId);
  if (!xml) throw makeError("conflict", "xml_missing");
  const xmlSha256 = await sha256Hex(xml.content);

  const authorization = await verifySendAuthorization(c.env, c.req.raw, {
    userId: c.get("userId"),
    invoiceId: id,
    xmlSha256,
    answer,
  });
  if (!authorization.ok) throw sendRefusedError(authorization.reason);

  // From here on the owner is present and the XML is the one they approved.
  const db = drizzle(c.env.DB, { schema });
  const settingsRow = await db
    .select({ sdi: schema.settings.sdiPecAddress })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1))
    .get();
  const to = sdiAddressFor(settingsRow?.sdi);
  const servers = await loadPecServers(c.env);
  const channel = channelDeps.create(c.env, servers);
  const messageId = messageIdFor(c.env.PEC_USERNAME);

  const claim = await c.env.DB.prepare(
    `UPDATE transmissions SET send_outcome = 'unknown', channel_message_id = ?2,
       sdi_pec_address = ?3, updated_at = ?4 WHERE id = ?1 AND send_outcome = 'none'`,
  )
    .bind(current.id, messageId, to, Date.now())
    .run();
  if (claim.meta.changes === 0) throw makeError("conflict", "send_in_progress");

  try {
    await channel.send({
      fileName: current.fileName,
      xml: xml.content,
      to,
      messageId,
      invoiceNumber: invoice.number_raw ?? "",
    });
  } catch (error) {
    if (error instanceof ChannelError && error.outcome === "none") {
      await c.env.DB.prepare(
        `UPDATE transmissions SET send_outcome = 'none', channel_message_id = NULL,
           updated_at = ?2 WHERE id = ?1`,
      )
        .bind(current.id, Date.now())
        .run();
    }
    throw sendFailure(error);
  }

  await c.env.DB.prepare(
    `UPDATE transmissions SET send_outcome = 'complete', updated_at = ?2 WHERE id = ?1`,
  )
    .bind(current.id, Date.now())
    .run();
  // The real channel waits for the PEC delivery receipt (step 13); the mock has none.
  if (isMockChannel(c.env)) await advanceState(c.env.DB, id, "sent");
  return c.json({ messageId, fileName: current.fileName, to, method: authorization.method });
});

/** Manual AdE channel: the owner uploaded the exported XML/PDF to the portal by hand. */
send.post("/:id/manual/handed-over", async (c) => {
  const id = c.req.param("id");
  const invoice = await loadRow(c.env.DB, id);
  if (invoice.state !== "sending") throw makeError("conflict", "invoice_not_sendable");
  const current = await currentTransmission(c.env.DB, id);
  if (current.outcome !== "none" || !current.xmlFileId) {
    throw makeError("conflict", current.xmlFileId ? "outcome_unknown" : "xml_missing");
  }
  const claim = await c.env.DB.prepare(
    `UPDATE transmissions SET channel = 'manual', send_outcome = 'complete', updated_at = ?2
     WHERE id = ?1 AND send_outcome = 'none'`,
  )
    .bind(current.id, Date.now())
    .run();
  if (claim.meta.changes === 0) throw makeError("conflict", "send_in_progress");
  await advanceState(c.env.DB, id, "sent");
  return c.json({ ok: true });
});

const manualOutcome = z.object({
  outcome: z.enum(["delivered", "not_delivered", "rejected"]),
  errors: z
    .array(
      z.object({
        code: z.string().trim().max(20).default(""),
        description: z.string().trim().min(1).max(500),
      }),
    )
    .max(20)
    .optional(),
});

const MANUAL_EVENT = {
  delivered: "RC",
  not_delivered: "MC",
  rejected: REJECTION_EVENT_TYPE,
} as const;

/** Manual AdE channel: records what the portal says (delivered / not delivered / rejected). */
send.post("/:id/manual/outcome", async (c) => {
  const id = c.req.param("id");
  const parsed = manualOutcome.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const { outcome, errors } = parsed.data;
  if (outcome === "rejected" && !errors?.length) {
    throw makeError("bad_request", "errors: required");
  }
  const invoice = await loadRow(c.env.DB, id);
  const current = await currentTransmission(c.env.DB, id);
  if (invoice.state !== "sent" || current.channel !== "manual") {
    throw makeError("conflict", "not_manual_sent");
  }
  const now = Date.now();
  const type = MANUAL_EVENT[outcome];
  // Same shape the polling step writes: step 9 reads `payload.errors[].{code, description}`.
  const payload = outcome === "rejected" ? { errors } : {};
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO events (id, source_id, type, invoice_id, transmission_id, payload,
         occurred_at, processed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      `manual:${current.id}:${type}`,
      type,
      id,
      current.id,
      JSON.stringify(payload),
      now,
      now,
      now,
    ),
    c.env.DB.prepare(
      `UPDATE invoices SET state = ?2, state_rank = ?3, updated_at = ?4
       WHERE id = ?1 AND state = 'sent'`,
    ).bind(id, outcome, INVOICE_STATES.indexOf(outcome), now),
  ]);
  return c.json({ state: outcome });
});
