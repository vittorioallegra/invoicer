import { type Context, Hono } from "hono";
import PostalMime from "postal-mime";
import { WorkerMailer } from "worker-mailer";
import { z } from "zod";
import { ApiError } from "../../shared/errors";
import type { Bindings } from "../env";
import { requireSecrets } from "../env";
import { pecServers } from "../pec/config";
import { parsePecEnvelope } from "../pec/envelope";
import { type ImapSocket, openMailbox } from "../pec/imap";
import { connectImap } from "../pec/socket";
import { makeError } from "../problem";
import { sampleInvoiceXml } from "./fixtures";

/** Largest message the fetch + parse probe downloads (the app's cap is 2 MB per blob). */
const MAX_PROBE_BYTES = 512 * 1024;

export type OpenSocket = (host: string, port: number) => ImapSocket;

async function headerSummary(bytes: Uint8Array | undefined) {
  if (!bytes) return { messageId: null, from: null, subject: null };
  const mail = await PostalMime.parse(bytes);
  return {
    messageId: mail.messageId ?? null,
    from: mail.from?.address ?? null,
    subject: mail.subject ?? null,
  };
}

/**
 * IMAP part of the PEC probe: login, EXAMINE, list the latest `count` message headers and
 * read the quota. Read-only. Nothing secret appears in the result.
 */
export async function imapProbe(env: Bindings, count: number, open: OpenSocket = connectImap) {
  requireSecrets(env, "pec");
  const { imapHost, imapPort } = pecServers(env);
  const started = Date.now();
  const client = await openMailbox(open(imapHost, imapPort), {
    username: env.PEC_USERNAME as string,
    password: env.PEC_PASSWORD as string,
  });
  try {
    const mailbox = await client.select("INBOX");
    // Search a recent UID window first; fall back to all UIDs when the window is too sparse.
    let uids = await client.searchNewerThan(Math.max(0, mailbox.uidNext - 1 - count * 5));
    if (uids.length < count) uids = await client.searchNewerThan(0);
    const latest = uids.slice(-count);
    const summaries = latest.length ? await client.fetchSummaries(latest) : [];
    const messages = [];
    for (const m of summaries.sort((a, b) => b.uid - a.uid)) {
      messages.push({
        uid: m.uid,
        size: m.size,
        flags: m.flags,
        internalDate: m.internalDate,
        ...(await headerSummary(m.sections["BODY[HEADER.FIELDS (MESSAGE-ID FROM SUBJECT DATE)]"])),
      });
    }
    const quota = await client.getQuota("INBOX");
    await client.logout();
    return {
      server: `${imapHost}:${imapPort}`,
      greeting: client.greetingText,
      uidValidity: mailbox.uidValidity,
      uidNext: mailbox.uidNext,
      exists: mailbox.exists,
      messages,
      quotaSupported: quota !== null,
      quota: quota && {
        ...quota,
        percentUsed: quota.limitKb ? Math.round((quota.usedKb / quota.limitKb) * 1000) / 10 : null,
      },
      wallMs: Date.now() - started,
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

/** Fetches the newest message in full and parses its PEC envelope (CPU probe on real data). */
export async function imapFetchParse(env: Bindings, open: OpenSocket = connectImap) {
  requireSecrets(env, "pec");
  const { imapHost, imapPort } = pecServers(env);
  const client = await openMailbox(open(imapHost, imapPort), {
    username: env.PEC_USERNAME as string,
    password: env.PEC_PASSWORD as string,
  });
  try {
    const mailbox = await client.select("INBOX");
    const uids = await client.searchNewerThan(Math.max(0, mailbox.uidNext - 11));
    const uid = uids.at(-1);
    if (!uid) return { skipped: "The mailbox has no message to fetch." };
    const [summary] = await client.fetchSummaries([uid]);
    if ((summary?.size ?? 0) > MAX_PROBE_BYTES) {
      return {
        skipped: `Newest message (UID ${uid}) is ${summary?.size} bytes, over the probe cap.`,
      };
    }
    const fetchStart = Date.now();
    const source = await client.fetchSource(uid);
    const fetchMs = Date.now() - fetchStart;
    await client.logout();
    if (!source) return { skipped: `UID ${uid} returned no body.` };
    const parseStart = Date.now();
    const envelope = await parsePecEnvelope(source);
    return {
      uid,
      bytes: source.byteLength,
      fetchWallMs: fetchMs,
      parseWallMs: Date.now() - parseStart,
      hasDaticert: envelope.daticert !== null,
      innerAttachments: envelope.inner?.attachments.map((a) => `${a.filename} (${a.size} B)`) ?? [],
      attachments: envelope.attachments.map((a) => `${a.filename} (${a.size} B)`),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export interface Mailer {
  send(email: Parameters<WorkerMailer["send"]>[0]): Promise<void>;
  close(): Promise<void>;
}
export type ConnectMailer = (
  options: Parameters<typeof WorkerMailer.connect>[0],
) => Promise<Mailer>;

/**
 * Sends a test PEC to the mailbox's own address with a sample FatturaPA XML attached (named like
 * a real transmission, but never sent to the SdI). The recipient is fixed: this probe can only
 * mail the owner.
 */
export async function smtpSend(
  env: Bindings,
  connect: ConnectMailer = (options) => WorkerMailer.connect(options),
) {
  requireSecrets(env, "pec");
  const { smtpHost, smtpPort } = pecServers(env);
  const username = env.PEC_USERNAME as string;
  const stamp = String(Date.now()).slice(-6);
  const xml = sampleInvoiceXml({
    fiscalId: "00000000000",
    recipientCode: "0000000",
    progressive: stamp,
    number: stamp,
  });
  const mailer = await connect({
    host: smtpHost,
    port: smtpPort,
    secure: true,
    startTls: false,
    authType: "plain",
    credentials: { username, password: env.PEC_PASSWORD as string },
    logLevel: 4,
  });
  const filename = `IT00000000000_${stamp}.xml`;
  try {
    await mailer.send({
      from: username,
      to: username,
      subject: `Invoicer spike test ${stamp}`,
      text: "Test message from the Invoicer risk spike. It carries a sample FatturaPA XML and was not sent to the SdI.",
      attachments: [{ filename, content: btoa(xml), mimeType: "application/xml" }],
    });
  } finally {
    await mailer.close();
  }
  return {
    server: `${smtpHost}:${smtpPort}`,
    to: "(own PEC address)",
    filename,
    xmlBytes: xml.length,
  };
}

const probeInput = z.object({ count: z.number().int().min(1).max(50).default(10) });

/**
 * Runs a probe and reports a connection or protocol failure as `{ ok: false, error }` (HTTP 502)
 * so the page shows what went wrong. Messages come from the IMAP client or the SMTP library and
 * are scrubbed of the password anyway; a missing secret keeps its problem+json (503).
 */
async function report(c: Context<{ Bindings: Bindings }>, run: () => Promise<unknown>) {
  try {
    return c.json({ ok: true, ...((await run()) as object) });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const password = c.env.PEC_PASSWORD;
    let message = error instanceof Error ? `${error.name}: ${error.message}` : "error";
    if (password) message = message.replaceAll(password, "***");
    return c.json({ ok: false, error: message.slice(0, 300) }, 502);
  }
}

export const pec = new Hono<{ Bindings: Bindings }>();

/** What is configured, without values; the page uses it to explain a skipped probe. */
pec.get("/status", (c) =>
  c.json({
    configured: Boolean(c.env.PEC_USERNAME && c.env.PEC_PASSWORD),
    ...pecServers(c.env),
  }),
);

pec.post("/imap-probe", async (c) => {
  const input = probeInput.safeParse(await c.req.json().catch(() => ({})));
  if (!input.success) throw makeError("bad_request", "count must be an integer from 1 to 50.");
  return report(c, () => imapProbe(c.env, input.data.count));
});

pec.post("/imap-fetch-parse", (c) => report(c, () => imapFetchParse(c.env)));

pec.post("/smtp-send", (c) => report(c, () => smtpSend(c.env)));
