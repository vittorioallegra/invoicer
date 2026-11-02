import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
import type { Bindings } from "../env";

/** Aruba PEC defaults; overridable with the PEC_*_HOST / PEC_*_PORT vars. */
export const PEC_DEFAULTS = {
  imapHost: "imaps.pec.aruba.it",
  imapPort: 993,
  smtpHost: "smtps.pec.aruba.it",
  smtpPort: 465,
} as const;

export interface PecServers {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

function port(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

export function pecServers(
  env: Pick<Bindings, "PEC_IMAP_HOST" | "PEC_IMAP_PORT" | "PEC_SMTP_HOST" | "PEC_SMTP_PORT">,
): PecServers {
  return {
    imapHost: env.PEC_IMAP_HOST || PEC_DEFAULTS.imapHost,
    imapPort: port(env.PEC_IMAP_PORT, PEC_DEFAULTS.imapPort),
    smtpHost: env.PEC_SMTP_HOST || PEC_DEFAULTS.smtpHost,
    smtpPort: port(env.PEC_SMTP_PORT, PEC_DEFAULTS.smtpPort),
  };
}

type ServerSettings = Pick<
  typeof schema.settings.$inferSelect,
  "pecImapHost" | "pecImapPort" | "pecSmtpHost" | "pecSmtpPort"
>;

/** Servers as stored in Settings (the editable presets); a column left empty falls back to env. */
export function pecServersWithSettings(
  env: Parameters<typeof pecServers>[0],
  row: ServerSettings | null | undefined,
): PecServers {
  const fallback = pecServers(env);
  return {
    imapHost: row?.pecImapHost || fallback.imapHost,
    imapPort: row?.pecImapPort || fallback.imapPort,
    smtpHost: row?.pecSmtpHost || fallback.smtpHost,
    smtpPort: row?.pecSmtpPort || fallback.smtpPort,
  };
}

/** Settings columns first, then the PEC_* vars, then the Aruba defaults. */
export async function loadPecServers(env: Bindings): Promise<PecServers> {
  const row = await drizzle(env.DB, { schema })
    .select({
      pecImapHost: schema.settings.pecImapHost,
      pecImapPort: schema.settings.pecImapPort,
      pecSmtpHost: schema.settings.pecSmtpHost,
      pecSmtpPort: schema.settings.pecSmtpPort,
    })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1))
    .get();
  return pecServersWithSettings(env, row);
}
