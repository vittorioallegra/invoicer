import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../../db/schema";
import { emailSettingsInputSchema } from "../../shared/profile";
import {
  issueSendChallenge,
  sendAnswerSchema,
  sendRefusedError,
  verifySendAuthorization,
} from "../auth/send-authorization";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { pecTestFromRow } from "../onboarding";
import { loadPecServers, PEC_DEFAULTS } from "../pec/config";
import { pecConnectionTestPlaced } from "../pec/poller";
import { makeError } from "../problem";
import { validationDetail } from "../validation";

export const settings = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

type SettingsValues = Partial<typeof schema.settings.$inferInsert>;

async function patchSettings(env: Bindings, values: SettingsValues): Promise<void> {
  const set = { ...values, updatedAt: new Date() };
  await drizzle(env.DB, { schema })
    .insert(schema.settings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: schema.settings.id, set });
}

settings.get("/", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const [row, profileRow] = await Promise.all([
    db.select().from(schema.settings).where(eq(schema.settings.id, 1)).get(),
    db
      .select({ name: schema.profile.name })
      .from(schema.profile)
      .where(eq(schema.profile.id, 1))
      .get(),
  ]);
  const servers = await loadPecServers(c.env);
  return c.json({
    email: {
      senderName: row?.emailSenderName ?? null,
      senderAddress: row?.emailSenderAddress ?? null,
      replyTo: row?.emailReplyTo ?? null,
      bcc: row?.emailBcc ?? null,
      mode: row?.courtesyEmailMode ?? "ask",
      /** What an empty sender name falls back to. */
      defaultSenderName: profileRow?.name ?? null,
      configured: Boolean(row?.emailConfiguredAt),
    },
    pec: {
      servers,
      /** Aruba defaults, for the "use preset" button. */
      preset: PEC_DEFAULTS,
      test: pecTestFromRow(row ?? null),
    },
    adeGuideDone: Boolean(row?.adeGuideDoneAt),
  });
});

settings.put("/email", async (c) => {
  const parsed = emailSettingsInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const { senderName, senderAddress, replyTo, bcc, mode } = parsed.data;
  await patchSettings(c.env, {
    emailSenderName: senderName,
    emailSenderAddress: senderAddress,
    emailReplyTo: replyTo,
    emailBcc: bcc,
    courtesyEmailMode: mode,
    emailConfiguredAt: new Date(),
  });
  return c.json({ ok: true });
});

/** The owner's UI language, so push text is written in it. */
settings.put("/language", async (c) => {
  const parsed = z
    .object({ language: z.enum(["en", "it"]) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  await patchSettings(c.env, { uiLanguage: parsed.data.language });
  return c.json({ language: parsed.data.language });
});

settings.put("/ade-guide", async (c) => {
  const parsed = z.object({ done: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  await patchSettings(c.env, { adeGuideDoneAt: parsed.data.done ? new Date() : null });
  return c.json({ done: parsed.data.done });
});

/**
 * A public DNS name: the mailbox password is sent to this host, so an IP address, a single-label
 * or internal name (`localhost`, `*.local`, `*.internal`) is refused.
 */
const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/, "invalid_host")
  .refine((host) => {
    const labels = host.toLowerCase().split(".");
    const last = labels[labels.length - 1] ?? "";
    return (
      labels.length >= 2 &&
      !/^\d+$/.test(last) &&
      !["local", "localhost", "internal", "lan", "home", "test", "invalid"].includes(last)
    );
  }, "invalid_host");
const portSchema = z.number().int().min(1).max(65535);
const serversFields = {
  imapHost: hostSchema,
  imapPort: portSchema,
  smtpHost: hostSchema,
  smtpPort: portSchema,
};
const serversProposal = z.object(serversFields);
const serversBody = z.object({ ...serversFields, answer: sendAnswerSchema });

async function serversDigest(servers: z.infer<typeof serversProposal>): Promise<string> {
  const { imapHost, imapPort, smtpHost, smtpPort } = servers;
  const text = JSON.stringify([imapHost.toLowerCase(), imapPort, smtpHost.toLowerCase(), smtpPort]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The PEC password is sent to these hosts, so changing them needs the owner's presence like a
 * send does: a challenge bound to the proposed servers, answered with a passkey (or TOTP code).
 */
settings.post("/pec-servers/challenge", async (c) => {
  const parsed = serversProposal.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  return c.json(
    await issueSendChallenge(c.env, c.req.url, {
      userId: c.get("userId"),
      invoiceId: null,
      xmlSha256: await serversDigest(parsed.data),
    }),
  );
});

/** Saves the IMAP/SMTP host and port presets; a changed server invalidates the last test. */
settings.put("/pec-servers", async (c) => {
  const parsed = serversBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const { imapHost, imapPort, smtpHost, smtpPort, answer } = parsed.data;
  const authorization = await verifySendAuthorization(c.env, c.req.raw, {
    userId: c.get("userId"),
    invoiceId: null,
    xmlSha256: await serversDigest({ imapHost, imapPort, smtpHost, smtpPort }),
    answer,
  });
  if (!authorization.ok) throw sendRefusedError(authorization.reason);
  await patchSettings(c.env, {
    pecImapHost: imapHost,
    pecImapPort: imapPort,
    pecSmtpHost: smtpHost,
    pecSmtpPort: smtpPort,
    pecTestAt: null,
    pecTestOk: null,
    pecTestError: null,
    pecTestQuotaUsedKb: null,
    pecTestQuotaLimitKb: null,
  });
  return c.json({ servers: await loadPecServers(c.env) });
});

/** Runs the PEC connection test (IMAP login, EXAMINE, quota, SMTP login) and stores the result. */
settings.post("/pec-test", async (c) => {
  const result = await pecConnectionTestPlaced(c.env);
  const at = new Date();
  await patchSettings(c.env, {
    pecTestAt: at,
    pecTestOk: result.ok,
    pecTestError: result.error,
    pecTestQuotaUsedKb: result.quota?.usedKb ?? null,
    pecTestQuotaLimitKb: result.quota?.limitKb ?? null,
  });
  return c.json({ ...result, at: at.getTime() });
});
