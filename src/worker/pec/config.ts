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
