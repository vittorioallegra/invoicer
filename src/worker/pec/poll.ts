import { MAX_FILE_BYTES } from "../../db/schema";
import { romeDateTime } from "../../shared/cron";
import { type Bindings, missingSecrets } from "../env";
import { finishJobRun, POLL_JOB, startJobRun } from "../jobs/job-runs";
import { notificationStatement, processOutbox } from "../outbox";
import { createD1FileStorage } from "../storage";
import {
  type Classification,
  classifyEnvelope,
  classifyLarge,
  PARSE_LIMIT_BYTES,
} from "./classify";
import { loadPecServers } from "./config";
import { planEffects } from "./effects";
import { parsePecEnvelope } from "./envelope";
import { type FetchedMessage, ImapError, type ImapSocket, openMailbox } from "./imap";
import { connectImap } from "./socket";

/** Per run caps: a backlog is worked off over several runs, resuming from the cursor. */
export const MAX_MESSAGES_PER_RUN = 20;
export const MAX_BYTES_PER_RUN = 3 * 1024 * 1024;

export const pollDeps: { open: (host: string, port: number) => ImapSocket } = {
  open: connectImap,
};

export interface PollCounts {
  /** Messages stored in this run (any kind). */
  stored: number;
  /** Already stored messages seen again (replays, rescans). */
  duplicates: number;
  /** Messages over the 2 MB cap, recorded without being fetched in full. */
  oversize: number;
  /** True when a cap stopped the run before the mailbox was drained. */
  more: boolean;
  /** True when the UIDVALIDITY changed and the mailbox is being rescanned. */
  rescan: boolean;
  [kind: string]: number | boolean;
}

const decoder = new TextDecoder();

interface Cursor {
  uidValidity: number | null;
  lastUid: number;
  sdiAddress: string | null;
}

async function loadCursor(db: D1Database): Promise<Cursor> {
  const row = await db
    .prepare(
      "SELECT mailbox_uid_validity, mailbox_last_uid, sdi_pec_address FROM settings WHERE id = 1",
    )
    .first<{
      mailbox_uid_validity: number | null;
      mailbox_last_uid: number | null;
      sdi_pec_address: string | null;
    }>();
  return {
    uidValidity: row?.mailbox_uid_validity ?? null,
    lastUid: row?.mailbox_last_uid ?? 0,
    sdiAddress: row?.sdi_pec_address ?? null,
  };
}

/** Cursor statement: only ever moves forward within the same UIDVALIDITY. */
export const advanceCursor = (db: D1Database, uidValidity: number, uid: number) =>
  db
    .prepare(
      `INSERT INTO settings (id, mailbox_uid_validity, mailbox_last_uid) VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET mailbox_uid_validity = ?1,
         mailbox_last_uid = MAX(?2, CASE WHEN mailbox_uid_validity = ?1
           THEN COALESCE(mailbox_last_uid, 0) ELSE 0 END)`,
    )
    .bind(uidValidity, uid);

async function hasSentAttempt(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS one FROM transmissions WHERE channel = 'pec' AND send_outcome != 'none' LIMIT 1",
    )
    .first();
  return row !== null;
}

/**
 * Where to start. The first run records the head of the mailbox and ignores older mail (the
 * history predates the app), unless an invoice was already sent: its receipts may sit below the
 * head, so everything is scanned. A changed UIDVALIDITY means every UID is new: rescan from the
 * start, deduplicated by Message-ID.
 */
async function resolveCursor(
  db: D1Database,
  info: { uidValidity: number; uidNext: number },
): Promise<{ cursor: Cursor; rescan: boolean }> {
  const cursor = await loadCursor(db);
  if (cursor.uidValidity === info.uidValidity) return { cursor, rescan: false };
  const first = cursor.uidValidity === null;
  const lastUid = first && !(await hasSentAttempt(db)) ? info.uidNext - 1 : 0;
  // A different UIDVALIDITY replaces the cursor outright (see `advanceCursor`).
  await advanceCursor(db, info.uidValidity, lastUid).run();
  return { cursor: { ...cursor, uidValidity: info.uidValidity, lastUid }, rescan: !first };
}

function header(message: FetchedMessage, name: string): string | null {
  const key = Object.keys(message.sections).find((k) => k.startsWith("BODY[HEADER"));
  const text = key ? decoder.decode(message.sections[key]).replace(/\r?\n[ \t]+/g, " ") : "";
  return new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(text)?.[1]?.trim() || null;
}

export interface StoredMessage {
  id: string;
  messageId: string;
  uidValidity: number;
  uid: number;
  size: number;
  classification: Classification;
  rawFileId: string | null;
  /** The received invoice's original file (extracted attachment, or the raw message). */
  receivedFileId?: string | null;
  receivedInvoiceId?: string;
  receivedAt: number | null;
  /** Why the message was recorded without being read in full, when it was not. */
  problem?: "oversize" | "vanished" | "parse_error";
}

/** Runs the poll against an open mailbox; returns what happened. */
async function processMailbox(
  env: Bindings,
  client: Awaited<ReturnType<typeof openMailbox>>,
  counts: PollCounts,
): Promise<void> {
  const info = await client.select("INBOX");
  const { cursor, rescan } = await resolveCursor(env.DB, info);
  counts.rescan = rescan;
  const uids = await client.searchNewerThan(cursor.lastUid);
  const batch = uids.slice(0, MAX_MESSAGES_PER_RUN);
  counts.more = uids.length > batch.length;
  if (batch.length === 0) return;

  const summaries = new Map((await client.fetchSummaries(batch)).map((m) => [m.uid, m]));
  const storage = createD1FileStorage(env.DB);
  let bytes = 0;

  for (const uid of batch) {
    const summary = summaries.get(uid);
    const size = summary?.size ?? 0;
    if (bytes > 0 && bytes + size > MAX_BYTES_PER_RUN) {
      counts.more = true;
      return;
    }
    bytes += size;
    const messageId =
      (summary && header(summary, "Message-ID")) ||
      `<uid-${info.uidValidity}-${uid}@no-message-id>`;

    const known = await env.DB.prepare(
      "SELECT 1 AS one FROM pec_messages WHERE message_id = ?1 OR (uid_validity = ?2 AND uid = ?3)",
    )
      .bind(messageId, info.uidValidity, uid)
      .first();
    if (known || !summary) {
      counts.duplicates += known ? 1 : 0;
      await advanceCursor(env.DB, info.uidValidity, uid).run();
      continue;
    }

    const id = crypto.randomUUID();
    const base = { id, messageId, uidValidity: info.uidValidity, uid, size };
    if (size > MAX_FILE_BYTES) {
      counts.oversize += 1;
      counts.stored += 1;
      await commitMessage(env, {
        ...base,
        classification: IGNORED,
        rawFileId: null,
        receivedAt: null,
        problem: "oversize",
      });
      continue;
    }

    const raw = await client.fetchSource(uid);
    if (!raw || raw.byteLength > MAX_FILE_BYTES) {
      counts.oversize += raw ? 1 : 0;
      counts.stored += 1;
      await commitMessage(env, {
        ...base,
        classification: IGNORED,
        rawFileId: null,
        receivedAt: null,
        problem: raw ? "oversize" : "vanished",
      });
      continue;
    }

    let classification: Classification;
    let parseFailed = false;
    try {
      classification =
        raw.byteLength > PARSE_LIMIT_BYTES
          ? classifyLarge(raw)
          : classifyEnvelope(await parsePecEnvelope(raw));
    } catch {
      classification = IGNORED;
      parseFailed = true;
    }

    // Only mail that matters is kept whole; unrelated mail leaves a row and no bytes.
    let rawFileId: string | null = null;
    if (classification.kind !== "ignored") {
      rawFileId = (
        await storage.put({
          kind: "pec_raw",
          filename: `${uid}.eml`,
          contentType: "message/rfc822",
          content: raw,
        })
      ).id;
    }
    // A received invoice keeps its original file: the extracted attachment, or (too large to
    // parse here) the raw message, which the browser opens.
    const receivedInvoiceId = crypto.randomUUID();
    let receivedFileId: string | null = rawFileId;
    if (classification.kind === "received_invoice" && classification.attachment) {
      const attachment = classification.attachment;
      receivedFileId = (
        await storage.put({
          kind: "received",
          filename: attachment.filename,
          contentType: /\.p7m$/i.test(attachment.filename)
            ? "application/pkcs7-mime"
            : "application/xml",
          content: attachment.content,
          receivedInvoiceId,
        })
      ).id;
    }
    try {
      await commitMessage(env, {
        ...base,
        classification,
        rawFileId,
        receivedFileId,
        receivedInvoiceId,
        receivedAt: classification.sentAt,
        problem: parseFailed ? "parse_error" : undefined,
      });
      counts.stored += 1;
      counts[classification.kind] = ((counts[classification.kind] as number | undefined) ?? 0) + 1;
    } catch (error) {
      if (rawFileId) await storage.delete(rawFileId);
      if (receivedFileId && receivedFileId !== rawFileId) await storage.delete(receivedFileId);
      throw error;
    }
  }
}

const IGNORED: Classification = { kind: "ignored", messageId: null, sentAt: null };

/** An error event and a notification for a message that could not be stored whole or read. */
function problemStatements(db: D1Database, m: StoredMessage, now: number): D1PreparedStatement[] {
  if (!m.problem || m.problem === "vanished") return [];
  const type = m.problem === "oversize" ? "pec_oversize" : "pec_parse_error";
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO events (id, source_id, type, payload, occurred_at, processed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        `${type}:${m.uidValidity}:${m.uid}`,
        type,
        JSON.stringify({ uid: m.uid, size: m.size, messageId: m.messageId }),
        now,
        now,
        now,
      ),
    m.problem === "oversize"
      ? notificationStatement(db, "message_oversize", { size: m.size }, now)
      : notificationStatement(db, "message_unreadable", {}, now),
  ];
}

/**
 * One D1 batch per message: the `pec_messages` row, its state transition and outbox rows, and the
 * cursor commit together, so the cursor never passes a message that was not committed.
 */
async function commitMessage(env: Bindings, message: StoredMessage): Promise<void> {
  const { classification: c } = message;
  const now = Date.now();
  const plan = await planEffects(
    env.DB,
    c,
    {
      id: message.id,
      messageId: message.messageId,
      receivedInvoiceId: message.receivedInvoiceId ?? crypto.randomUUID(),
      receivedFileId: message.receivedFileId ?? message.rawFileId,
    },
    now,
  );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pec_messages (id, message_id, uid_validity, uid, kind, sdi_message_type,
         original_file_name, size, raw_file_id, received_at, processed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      message.id,
      message.messageId,
      message.uidValidity,
      message.uid,
      c.kind,
      c.kind === "sdi_message" ? c.type : null,
      c.kind === "sdi_message" ? c.fileName : c.kind === "received_invoice" ? c.fileName : null,
      message.size,
      message.rawFileId,
      message.receivedAt,
      plan.processed ? now : null,
      now,
    ),
    ...plan.statements,
    ...problemStatements(env.DB, message, now),
    advanceCursor(env.DB, message.uidValidity, message.uid),
  ]);
}

/** Side effects queued by the polling run; whatever failed earlier is retried on every tick. */
async function deliverOutbox(env: Bindings): Promise<void> {
  try {
    await processOutbox(env);
  } catch {
    console.error("outbox_failed");
  }
}

/** Connects and logs in; anything that is not an IMAP answer (DNS, TLS, a dropped socket) is a connection failure. */
async function connect(env: Bindings, servers: { imapHost: string; imapPort: number }) {
  try {
    return await openMailbox(pollDeps.open(servers.imapHost, servers.imapPort), {
      username: env.PEC_USERNAME as string,
      password: env.PEC_PASSWORD as string,
    });
  } catch (error) {
    throw error instanceof ImapError ? error : new ImapError("closed", "Connection failed.");
  }
}

export function pollErrorCode(error: unknown): string {
  if (error instanceof ImapError) {
    if (error.code === "login_failed") return "login_failed";
    if (error.code === "closed") return "connection_failed";
    return "protocol_error";
  }
  return "poll_failed";
}

/**
 * One mailbox poll (the cron job). Read-only on the mailbox. Skipped silently while the PEC
 * secrets are unset. Every run leaves a `job_runs` row; a failure is recorded with its code.
 */
export async function pollMailbox(
  env: Bindings,
  now = Date.now(),
): Promise<{ ok: boolean; counts: PollCounts; errorCode?: string } | null> {
  if (missingSecrets(env, "pec").length > 0) return null;
  const counts: PollCounts = {
    stored: 0,
    duplicates: 0,
    oversize: 0,
    more: false,
    rescan: false,
  };
  const runId = await startJobRun(env.DB, POLL_JOB, romeDateTime(new Date(now)).date, now);
  try {
    const servers = await loadPecServers(env);
    const client = await connect(env, servers);
    try {
      await processMailbox(env, client, counts);
      await client.logout();
    } catch (error) {
      await client.close();
      throw error;
    }
    await finishJobRun(env.DB, runId, { status: "success", counts });
    await deliverOutbox(env);
    return { ok: true, counts };
  } catch (error) {
    const errorCode = pollErrorCode(error);
    console.error("poll_failed", errorCode);
    await finishJobRun(env.DB, runId, { status: "failed", counts, errorCode });
    await notificationStatement(env.DB, "poll_failed", { code: errorCode }, Date.now(), {
      unlessUnread: true,
    })
      .run()
      .catch(() => undefined);
    await deliverOutbox(env);
    return { ok: false, counts, errorCode };
  }
}
