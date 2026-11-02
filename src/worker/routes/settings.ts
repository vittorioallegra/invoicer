import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../../db/schema";
import { romeDateTime } from "../../shared/cron";
import { emailSettingsInputSchema, minimumNextNumber } from "../../shared/profile";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { pecTestFromRow } from "../onboarding";
import { loadPecServers, PEC_DEFAULTS } from "../pec/config";
import { pecConnectionTest } from "../pec/connection-test";
import { makeError } from "../problem";
import { validationDetail } from "../validation";

export const settings = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

const MAX_NUMBER = 999_999_999;

type SettingsValues = Partial<typeof schema.settings.$inferInsert>;

async function patchSettings(env: Bindings, values: SettingsValues): Promise<void> {
  const set = { ...values, updatedAt: new Date() };
  await drizzle(env.DB, { schema })
    .insert(schema.settings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: schema.settings.id, set });
}

/** Invoice numbering for the current Europe/Rome year. */
async function numbering(env: Bindings) {
  const year = Number(romeDateTime(new Date()).date.slice(0, 4));
  const used = await env.DB.prepare(
    "SELECT MAX(number_int) AS highest FROM invoices WHERE year = ?",
  )
    .bind(year)
    .first<{ highest: number | null }>();
  const sequence = await env.DB.prepare("SELECT last_number FROM number_sequences WHERE year = ?")
    .bind(year)
    .first<{ last_number: number }>();
  const highestUsed = used?.highest ?? null;
  return {
    year,
    next: Math.max(sequence?.last_number ?? 0, highestUsed ?? 0) + 1,
    minimum: minimumNextNumber(highestUsed),
  };
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
    invoiceNumber: await numbering(c.env),
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

const numberBody = z.object({ number: z.number().int().min(1).max(MAX_NUMBER) });

/** Sets the number the next invoice of the current year gets; never below a number in use. */
settings.put("/invoice-number", async (c) => {
  const parsed = numberBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const { year, minimum } = await numbering(c.env);
  if (parsed.data.number < minimum) {
    throw makeError("conflict", `number: below_used (the lowest allowed number is ${minimum})`);
  }
  await c.env.DB.prepare(
    `INSERT INTO number_sequences (year, last_number) VALUES (?, ?)
       ON CONFLICT(year) DO UPDATE SET last_number = excluded.last_number`,
  )
    .bind(year, parsed.data.number - 1)
    .run();
  return c.json(await numbering(c.env));
});

settings.put("/ade-guide", async (c) => {
  const parsed = z.object({ done: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  await patchSettings(c.env, { adeGuideDoneAt: parsed.data.done ? new Date() : null });
  return c.json({ done: parsed.data.done });
});

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/, "invalid_host");
const portSchema = z.number().int().min(1).max(65535);
const serversBody = z.object({
  imapHost: hostSchema,
  imapPort: portSchema,
  smtpHost: hostSchema,
  smtpPort: portSchema,
});

/** Saves the IMAP/SMTP host and port presets; a changed server invalidates the last test. */
settings.put("/pec-servers", async (c) => {
  const parsed = serversBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", validationDetail(parsed.error));
  const { imapHost, imapPort, smtpHost, smtpPort } = parsed.data;
  await patchSettings(c.env, {
    pecImapHost: imapHost,
    pecImapPort: imapPort,
    pecSmtpHost: smtpHost,
    pecSmtpPort: smtpPort,
    pecTestAt: null,
    pecTestOk: null,
    pecTestError: null,
  });
  return c.json({ servers: await loadPecServers(c.env) });
});

/** Runs the PEC connection test (IMAP login, EXAMINE, quota, SMTP login) and stores the result. */
settings.post("/pec-test", async (c) => {
  const result = await pecConnectionTest(c.env);
  const at = new Date();
  await patchSettings(c.env, {
    pecTestAt: at,
    pecTestOk: result.ok,
    pecTestError: result.error,
  });
  return c.json({ ...result, at: at.getTime() });
});
