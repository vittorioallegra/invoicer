import { buildPushHTTPRequest } from "@pushforge/builder";
import { Hono } from "hono";
import type { Bindings } from "../env";
import { parsePecEnvelope } from "../pec/envelope";
import {
  PEC_RECEIPT_SOURCE,
  pecInvoiceEnvelope,
  SDI_RECEIPT_SOURCE,
} from "../pec/message-fixtures";
import { makeError } from "../problem";
import { ASSERTION_FIXTURE, PUSH_SUBSCRIPTION_FIXTURE } from "./fixtures";
import { verifyAssertion } from "./passkey";
import { timed } from "./util";

const encoder = new TextEncoder();

/** PBKDF2-HMAC-SHA256 as Better Auth's replacement would run it (32-byte output). */
export async function pbkdf2(iterations: number): Promise<number> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode("correct horse battery staple"),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return bits.byteLength;
}

export async function passkeyVerifyFixture(): Promise<boolean> {
  const f = ASSERTION_FIXTURE;
  const result = await verifyAssertion({
    response: f.response,
    credential: { id: f.credentialID, publicKey: f.publicKey, counter: f.counter - 1 },
    expectedChallenge: f.challenge,
    origin: f.origin,
    rpID: f.rpID,
  });
  return result.verified;
}

export async function pushEncryptFixture(
  env: Pick<Bindings, "VAPID_PRIVATE_KEY">,
): Promise<number> {
  // Uses the real VAPID key when configured; otherwise a throwaway key generated in the request
  // (adds one P-256 key generation, well below 1 ms).
  let privateJWK: JsonWebKey | string;
  if (env.VAPID_PRIVATE_KEY) {
    privateJWK = env.VAPID_PRIVATE_KEY;
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ])) as CryptoKeyPair;
    privateJWK = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  }
  const request = await buildPushHTTPRequest({
    privateJWK,
    subscription: PUSH_SUBSCRIPTION_FIXTURE,
    message: {
      payload: {
        title: "Invoice delivered",
        body: "Invoice 12/2026 was delivered.",
        url: "/issued",
      },
      adminContact: "mailto:spike@example.invalid",
    },
  });
  return request.body.byteLength;
}

/** PEC mail parsing probes: an SdI receipt (~1 KB), a PEC envelope (~3 KB), a 100 KB invoice. */
export async function pecParseFixture(kind: string): Promise<unknown> {
  const source =
    kind === "pec-parse-receipt"
      ? SDI_RECEIPT_SOURCE
      : kind === "pec-parse-envelope"
        ? PEC_RECEIPT_SOURCE
        : pecInvoiceEnvelope(100_000);
  const parsed = await parsePecEnvelope(source);
  return {
    bytes: source.length,
    inner: parsed.inner?.attachments.map((a) => `${a.filename} (${a.size} B)`) ?? [],
  };
}

export const cpu = new Hono<{ Bindings: Bindings }>();

/**
 * One operation per request, so the per-request CPU time shown by `wrangler tail` / the
 * dashboard is attributable. `clockMs` is the in-Worker clock (0 on deployed Workers for pure CPU).
 */
cpu.post("/:name", async (c) => {
  const name = c.req.param("name");
  const iterations = Number(c.req.query("iterations") ?? 10000);
  const run = async (): Promise<unknown> => {
    switch (name) {
      case "pbkdf2":
        if (!Number.isInteger(iterations) || iterations < 1)
          throw makeError("bad_request", "iterations");
        return { iterations, bytes: await pbkdf2(iterations) };
      case "passkey-verify":
        return { verified: await passkeyVerifyFixture() };
      case "push-encrypt":
        return { bodyBytes: await pushEncryptFixture(c.env) };
      case "pec-parse-receipt":
      case "pec-parse-envelope":
      case "pec-parse-invoice":
        return await pecParseFixture(name);
      default:
        throw makeError("not_found");
    }
  };
  try {
    const { value, clockMs } = await timed(run);
    return c.json({ name, ok: true, clockMs, detail: value });
  } catch (error) {
    // ApiError (missing token, bad input) keeps its problem+json; crypto limits are reported.
    if (error instanceof Error && error.name === "ApiError") throw error;
    return c.json(
      {
        name,
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : "error",
      },
      200,
    );
  }
});
