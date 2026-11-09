import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../../db/schema";
import type { Bindings } from "../env";
import { makeError } from "../problem";
import { appOrigin, createAuth } from "./auth";
import type { SessionVariables } from "./session";

/**
 * Send authorization (plan step 5). Sending a PEC uses the mailbox credentials, which are Worker
 * secrets, so the Worker demands proof that the owner is present for each send: a passkey
 * assertion with user verification (fallback: a fresh TOTP code). The proof is bound to one
 * invoice and to the SHA-256 of its final XML through a single-use, short-lived challenge row in
 * `send_challenges`. The send flow (step 12) calls `verifySendAuthorization` before it opens any
 * SMTP connection.
 */

/** A challenge is answered within this time or it is refused. */
export const CHALLENGE_TTL_MS = 2 * 60 * 1000;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase hex SHA-256.");

const issueBody = z.object({ xmlSha256: sha256Hex });

/** What the browser sends back to the send endpoint alongside the invoice. */
export const sendAnswerSchema = z.object({
  challengeId: z.string().min(1),
  /** The `navigator.credentials.get()` result, serialised (SimpleWebAuthn browser JSON). */
  passkey: z.custom<AuthenticationResponseJSON>((value) => typeof value === "object").optional(),
  /** Fallback: a fresh 6-digit TOTP code. */
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type SendAnswer = z.infer<typeof sendAnswerSchema>;

export type RefusalReason =
  | "unknown_challenge"
  | "expired"
  | "already_used"
  | "wrong_invoice"
  | "wrong_xml"
  | "no_answer"
  | "invalid_passkey"
  | "invalid_totp"
  | "totp_locked";

export type SendAuthorization =
  | { ok: true; method: "passkey" | "totp" }
  | { ok: false; reason: RefusalReason };

const refuse = (reason: RefusalReason): SendAuthorization => ({ ok: false, reason });

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function rpId(env: Bindings, requestUrl: string): string {
  return new URL(appOrigin(env, requestUrl)).hostname;
}

/**
 * Issues a challenge for one send. Returns the WebAuthn request options (the challenge is the
 * random value the passkey signs; its binding to the invoice and XML hash lives in D1).
 */
export async function issueSendChallenge(
  env: Bindings,
  requestUrl: string,
  input: { userId: string; invoiceId: string | null; xmlSha256: string },
) {
  const db = drizzle(env.DB, { schema });
  const passkeys = await db
    .select({ credentialID: schema.passkey.credentialID, transports: schema.passkey.transports })
    .from(schema.passkey)
    .where(eq(schema.passkey.userId, input.userId));
  const [totp] = await db
    .select({ verified: schema.twoFactor.verified })
    .from(schema.twoFactor)
    .where(eq(schema.twoFactor.userId, input.userId))
    .limit(1);

  const options = await generateAuthenticationOptions({
    rpID: rpId(env, requestUrl),
    userVerification: "required",
    timeout: CHALLENGE_TTL_MS,
    allowCredentials: passkeys.map((key) => ({
      id: key.credentialID,
      transports: (key.transports?.split(",") ?? []) as never,
    })),
  });

  const now = Date.now();
  const challengeId = crypto.randomUUID();
  // Expired rows are useless: drop them while we are here.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM send_challenges WHERE expires_at < ?").bind(now - CHALLENGE_TTL_MS),
    env.DB.prepare(
      `INSERT INTO send_challenges (id, challenge, invoice_id, xml_sha256, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      challengeId,
      options.challenge,
      input.invoiceId,
      input.xmlSha256,
      now + CHALLENGE_TTL_MS,
      now,
    ),
  ]);

  return {
    challengeId,
    expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
    /** Pass to `navigator.credentials.get({ publicKey })` (or SimpleWebAuthn's `startAuthentication`). */
    options,
    passkeyAvailable: passkeys.length > 0,
    totpAvailable: totp?.verified === true,
  };
}

/**
 * Checks the owner's answer to a challenge. The challenge is consumed first, atomically, so every
 * answer (right or wrong) uses it up: a replay, or a second guess at a TOTP code, needs a new
 * challenge. Opens no connection and touches no secret: the caller sends only on `ok: true`.
 */
export async function verifySendAuthorization(
  env: Bindings,
  request: Request,
  input: { userId: string; invoiceId: string | null; xmlSha256: string; answer: SendAnswer },
): Promise<SendAuthorization> {
  const now = Date.now();
  const claimed = await env.DB.prepare(
    `UPDATE send_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at >= ?
     RETURNING challenge, invoice_id, xml_sha256`,
  )
    .bind(now, input.answer.challengeId, now)
    .first<{ challenge: string; invoice_id: string | null; xml_sha256: string }>();

  if (!claimed) {
    const row = await env.DB.prepare("SELECT used_at FROM send_challenges WHERE id = ?")
      .bind(input.answer.challengeId)
      .first<{ used_at: number | null }>();
    if (!row) return refuse("unknown_challenge");
    return refuse(row.used_at === null ? "expired" : "already_used");
  }
  if (claimed.invoice_id !== input.invoiceId) return refuse("wrong_invoice");
  if (claimed.xml_sha256 !== input.xmlSha256) return refuse("wrong_xml");

  if (input.answer.passkey) {
    return verifyPasskey(env, request, input.userId, claimed.challenge, input.answer.passkey);
  }
  if (input.answer.totp) return verifyTotp(env, request, input.userId, input.answer.totp);
  return refuse("no_answer");
}

async function verifyPasskey(
  env: Bindings,
  request: Request,
  userId: string,
  challenge: string,
  response: AuthenticationResponseJSON,
): Promise<SendAuthorization> {
  const db = drizzle(env.DB, { schema });
  // Only the signed-in owner's own passkeys count.
  const [stored] = await db
    .select()
    .from(schema.passkey)
    .where(and(eq(schema.passkey.userId, userId), eq(schema.passkey.credentialID, response.id)))
    .limit(1);
  if (!stored) return refuse("invalid_passkey");
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: appOrigin(env, request.url),
      expectedRPID: rpId(env, request.url),
      requireUserVerification: true,
      credential: {
        id: stored.credentialID,
        publicKey: decodeBase64(stored.publicKey),
        counter: stored.counter,
        transports: (stored.transports?.split(",") ?? []) as never,
      },
    });
    if (!result.verified) return refuse("invalid_passkey");
    await db
      .update(schema.passkey)
      .set({ counter: result.authenticationInfo.newCounter })
      .where(eq(schema.passkey.id, stored.id));
    return { ok: true, method: "passkey" };
  } catch {
    return refuse("invalid_passkey");
  }
}

/** Consecutive wrong send codes that lock the TOTP, and for how long (Better Auth's defaults). */
export const TOTP_MAX_FAILURES = 10;
export const TOTP_LOCK_MS = 15 * 60 * 1000;

/**
 * Reuses Better Auth's own TOTP check (it decrypts the stored secret), on the owner's session.
 * Called with a session, Better Auth applies neither its rate limit nor its lockout, so a stolen
 * session could guess codes one challenge at a time; the send keeps the same account lockout on
 * the `two_factor` row that the sign-in uses (shared counter), and only a verified TOTP counts.
 */
async function verifyTotp(
  env: Bindings,
  request: Request,
  userId: string,
  code: string,
): Promise<SendAuthorization> {
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT id, verified, locked_until FROM two_factor WHERE user_id = ? LIMIT 1",
  )
    .bind(userId)
    .first<{ id: string; verified: number | null; locked_until: number | null }>();
  if (!row || row.verified === 0) return refuse("invalid_totp");
  if (row.locked_until !== null && row.locked_until > now) return refuse("totp_locked");
  try {
    await createAuth(env, request.url).api.verifyTOTP({
      body: { code },
      headers: request.headers,
    });
  } catch {
    // An expired lock starts a fresh count; the failure that reaches the budget locks.
    await env.DB.prepare(
      `UPDATE two_factor SET
         failed_verification_count = (CASE WHEN locked_until IS NOT NULL AND locked_until <= ?2
           THEN 0 ELSE COALESCE(failed_verification_count, 0) END) + 1,
         locked_until = CASE
           WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= ?2
                  THEN 0 ELSE COALESCE(failed_verification_count, 0) END) + 1 >= ?3
           THEN ?4 ELSE NULL END
       WHERE id = ?1`,
    )
      .bind(row.id, now, TOTP_MAX_FAILURES, now + TOTP_LOCK_MS)
      .run();
    return refuse("invalid_totp");
  }
  await env.DB.prepare(
    "UPDATE two_factor SET failed_verification_count = 0, locked_until = NULL WHERE id = ?",
  )
    .bind(row.id)
    .run();
  return { ok: true, method: "totp" };
}

export const sendAuthorization = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

/** `POST /api/invoices/:id/send-challenge` with `{ xmlSha256 }`: starts one authorized send. */
sendAuthorization.post("/:id/send-challenge", async (c) => {
  const parsed = issueBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw makeError("bad_request", "Expected { xmlSha256 } as lowercase hex.");
  const invoiceId = c.req.param("id");
  const invoice = await c.env.DB.prepare("SELECT 1 AS found FROM invoices WHERE id = ?")
    .bind(invoiceId)
    .first();
  if (!invoice) throw makeError("not_found");
  return c.json(
    await issueSendChallenge(c.env, c.req.url, {
      userId: c.get("userId"),
      invoiceId,
      xmlSha256: parsed.data.xmlSha256,
    }),
  );
});

/** Refusal reason to the problem+json the send endpoint returns (never says which secret). */
export function sendRefusedError(reason: RefusalReason) {
  return makeError("send_not_authorized", `Send authorization refused: ${reason}.`);
}
