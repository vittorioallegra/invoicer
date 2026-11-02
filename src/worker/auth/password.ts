import { safeEqual } from "./crypto";

/**
 * PBKDF2 (Web Crypto) password hashing for the email + password fallback.
 *
 * 10,000 iterations is the highest count that stays under the 10 ms free-plan CPU limit on
 * a Worker (docs/notes/spike.md). The weak work factor is compensated by the mandatory TOTP,
 * the login rate limit and a generated password. The iteration count is stored in the hash
 * string, so it can be raised later (Workers Paid) without invalidating existing hashes.
 */
export const PBKDF2_ITERATIONS = 10_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;
const PREFIX = "pbkdf2-sha256";

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BITS,
  );
  return toBase64Url(new Uint8Array(bits));
}

/** Returns `pbkdf2-sha256$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `${PREFIX}$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${hash}`;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [prefix, iterations, salt, hash] = stored.split("$");
  const count = Number(iterations);
  if (prefix !== PREFIX || !salt || !hash || !Number.isInteger(count) || count < 1) return false;
  // Workers refuse more than 100,000 PBKDF2 iterations; a larger stored count cannot be valid.
  if (count > 100_000) return false;
  return safeEqual(hash, await derive(password, fromBase64Url(salt), count));
}
