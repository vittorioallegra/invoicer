import { type Bindings, requireSecrets } from "../env";

const RESEND_URL = "https://api.resend.com/emails";

export interface ResendMessage {
  from: string;
  to: string[];
  bcc: string[];
  replyTo: string | null;
  subject: string;
  text: string;
  attachments: { filename: string; content: Uint8Array }[];
}

/** A refusal or an outage of the provider; `code` is safe to store (status and Resend error name). */
export class EmailSendError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EmailSendError";
  }
}

/** Test seam: the HTTP call to Resend (no automated test talks to the real API). */
export const resendDeps = {
  fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
};

/** Base64 in chunks: one `btoa` over a binary string, cheap enough for a ~100 KB PDF. */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Sends one email through the Resend API. The `Idempotency-Key` makes a retry of the same send
 * (a crash after the call, a double click) return the first result instead of a second email.
 * Missing `RESEND_API_KEY` throws the `missing_secret` ApiError naming it.
 */
export async function sendWithResend(
  env: Bindings,
  message: ResendMessage,
  idempotencyKey: string,
): Promise<{ id: string }> {
  requireSecrets(env, "email");
  const body = JSON.stringify({
    from: message.from,
    to: message.to,
    ...(message.bcc.length > 0 ? { bcc: message.bcc } : {}),
    ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    subject: message.subject,
    text: message.text,
    attachments: message.attachments.map((a) => ({
      filename: a.filename,
      content: toBase64(a.content),
    })),
  });
  let response: Response;
  try {
    response = await resendDeps.fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body,
    });
  } catch {
    throw new EmailSendError("resend_unreachable");
  }
  const json = (await response.json().catch(() => null)) as {
    id?: unknown;
    name?: unknown;
  } | null;
  if (!response.ok) {
    const name = typeof json?.name === "string" ? json.name.replace(/\W+/g, "_") : "error";
    throw new EmailSendError(`resend_${response.status}_${name}`);
  }
  if (typeof json?.id !== "string") throw new EmailSendError("resend_bad_response");
  return { id: json.id };
}
