import { ChannelError, type ChannelErrorCode } from "./types";

/**
 * Removes secrets from text before it is logged or reported: the password, the username, any
 * `AUTH` line of an SMTP transcript and base64 credentials that follow it.
 */
export function scrubSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.replaceAll(secret, "***");
  }
  return out
    .replace(/^.*\bAUTH\b.*$/gim, "AUTH ***")
    .replace(/(Failed to (?:plain|login) authentication:)[^\n]*/gi, "$1 ***");
}

const replyCode = (message: string) => /\b([245]\d\d)\b/.exec(message)?.[1] ?? null;

/** Failure while connecting and authenticating: nothing was sent. */
export function mapConnectError(error: unknown, secrets: readonly (string | undefined)[]) {
  const raw = error instanceof Error ? error.message : "";
  const message = scrubSecrets(raw, secrets);
  const code = replyCode(message);
  let reason: ChannelErrorCode = "unavailable";
  if (/authentication|Invalid login|No supported auth/i.test(message) || code === "535") {
    reason = "auth_failed";
  }
  return new ChannelError(reason, "none");
}

/**
 * Failure while sending on an open session. A reply from the server (MAIL FROM, RCPT TO, DATA or
 * the body) is a definite refusal; a timeout or a closed connection may have happened after the
 * server took the message, so the outcome is unknown.
 */
export function mapSendError(error: unknown, secrets: readonly (string | undefined)[]) {
  const message = scrubSecrets(error instanceof Error ? error.message : "", secrets);
  if (
    /^(Invalid MAIL FROM|Invalid RCPT TO|Failed to send DATA|Failed send email body)/.test(message)
  ) {
    const code = replyCode(message);
    if (/mailbox full|quota|over ?quota|insufficient storage/i.test(message) || code === "552") {
      return new ChannelError("mailbox_full", "none");
    }
    if (/RCPT TO/.test(message) && (code === "550" || code === "553" || code === "551")) {
      return new ChannelError("sdi_address_missing", "none");
    }
    return new ChannelError("rejected", "none");
  }
  return new ChannelError("unknown_outcome", "unknown");
}
