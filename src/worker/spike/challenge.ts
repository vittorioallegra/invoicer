import { safeEqual } from "./gate";
import { fromBase64Url, toBase64Url } from "./util";

const encoder = new TextEncoder();
const TTL_SECONDS = 120;

async function mac(secret: string, purpose: string, bind: string, body: Uint8Array) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = encoder.encode(`${purpose}|${bind}|`);
  const data = new Uint8Array(prefix.length + body.length);
  data.set(prefix);
  data.set(body, prefix.length);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data)).slice(0, 16);
}

/**
 * Stateless WebAuthn challenge for the spike: nonce(16) | expiry(4, seconds) | MAC(16) over
 * purpose and a caller-supplied binding string (stands in for invoice id + XML hash). Step 5
 * stores single-use challenges in D1 instead; this only proves the browser signs what we bound.
 */
export async function issueChallenge(
  secret: string,
  purpose: "register" | "authenticate",
  bind: string,
  nowMs = Date.now(),
): Promise<Uint8Array<ArrayBuffer>> {
  const body = new Uint8Array(new ArrayBuffer(20));
  crypto.getRandomValues(body.subarray(0, 16));
  new DataView(body.buffer).setUint32(16, Math.floor(nowMs / 1000) + TTL_SECONDS);
  const tag = await mac(secret, purpose, bind, body);
  const out = new Uint8Array(new ArrayBuffer(36));
  out.set(body);
  out.set(tag, 20);
  return out;
}

export async function checkChallenge(
  secret: string,
  purpose: "register" | "authenticate",
  bind: string,
  challenge: string,
  nowMs = Date.now(),
): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(challenge);
  } catch {
    return false;
  }
  if (bytes.length !== 36) return false;
  const body = bytes.slice(0, 20);
  const expiry = new DataView(body.buffer).getUint32(16);
  if (expiry < Math.floor(nowMs / 1000)) return false;
  const expected = toBase64Url(await mac(secret, purpose, bind, body));
  return safeEqual(expected, toBase64Url(bytes.slice(20)));
}
