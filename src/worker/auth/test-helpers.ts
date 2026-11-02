// Test-only helpers: a cookie-keeping API client, TOTP generation and a virtual WebAuthn
// authenticator (ES256, attestation "none"), so auth flows run end to end without a device.
import { env } from "cloudflare:test";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { createApp } from "../app";
import type { Bindings } from "../env";

export const ORIGIN = "http://localhost";
export const SETUP_TOKEN = "test-setup-token";
export const OWNER = {
  name: "Owner",
  email: "owner@example.com",
  password: "a-long-test-password",
};

const migrations = import.meta.glob("../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export async function applyMigrations(db: D1Database): Promise<void> {
  for (const file of Object.keys(migrations).sort()) {
    const statements = (migrations[file] ?? "").split("--> statement-breakpoint");
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
}

/** Minimal HTTP client over the Hono app that keeps cookies, like a browser tab. */
export class TestClient {
  private cookies = new Map<string, string>();
  constructor(
    private readonly ip: string,
    private readonly bindings: Bindings = env as unknown as Bindings,
  ) {}

  /** The `Cookie` header the client would send now (for calls that bypass the HTTP layer). */
  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async request(
    path: string,
    init: { method?: string; body?: unknown; contentType?: string } = {},
  ): Promise<Response> {
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    const headers: Record<string, string> = {
      "CF-Connecting-IP": this.ip,
      Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    };
    if (method !== "GET") headers.Origin = ORIGIN;
    if (init.body !== undefined) headers["Content-Type"] = init.contentType ?? "application/json";
    const response = await createApp().request(
      `${ORIGIN}${path}`,
      {
        method,
        headers,
        ...(init.body === undefined
          ? {}
          : { body: init.body instanceof Uint8Array ? init.body : JSON.stringify(init.body) }),
      },
      this.bindings,
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = cookie.split(";");
      const [name = "", ...value] = pair.split("=");
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value.join("=") === "") this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value.join("="));
    }
    return response;
  }

  async json<T = Record<string, unknown>>(
    path: string,
    init: { method?: string; body?: unknown; contentType?: string } = {},
  ): Promise<{ status: number; body: T }> {
    const response = await this.request(path, init);
    return { status: response.status, body: (await response.json().catch(() => null)) as T };
  }
}

export const setupOwner = (client: TestClient, token = SETUP_TOKEN) =>
  client.json("/api/setup", { body: { token, ...OWNER } });

export const signIn = (client: TestClient, password = OWNER.password) =>
  client.json("/api/auth/sign-in/email", { body: { email: OWNER.email, password } });

// --- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) --------------------------------------------------

function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of input.replaceAll("=", "").toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
}

export async function totpCode(totpUri: string, offsetSteps = 0): Promise<string> {
  const secret = new URL(totpUri).searchParams.get("secret") ?? "";
  const counter = Math.floor(Date.now() / 30_000) + offsetSteps;
  const message = new DataView(new ArrayBuffer(8));
  message.setUint32(4, counter);
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message.buffer));
  const offset = (mac[19] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

// --- Virtual authenticator -------------------------------------------------------------------

const sha256 = async (data: BufferSource) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", data));
const utf8 = (text: string) => new TextEncoder().encode(text);

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Converts a raw r||s ECDSA signature to the DER form WebAuthn carries. */
function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const int = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const trimmed = bytes.slice(start);
    const padded = (trimmed[0] ?? 0) & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
    return concat(Uint8Array.of(0x02, padded.length), padded);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

const counterBytes = (n: number) => Uint8Array.of(n >>> 24, n >>> 16, n >>> 8, n);

export class VirtualAuthenticator {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  private signCount = 0;
  private keys?: CryptoKeyPair;

  private async keyPair(): Promise<CryptoKeyPair> {
    this.keys ??= (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    return this.keys;
  }

  get id(): string {
    return isoBase64URL.fromBuffer(this.credentialId);
  }

  private clientData(type: string, challenge: string, origin: string) {
    return utf8(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    ) as Uint8Array<ArrayBuffer>;
  }

  /** Answers `navigator.credentials.create()` with attestation "none". */
  async register(options: { challenge: string; rp: { id?: string } }, origin = ORIGIN) {
    const { publicKey } = await this.keyPair();
    const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as unknown as JsonWebKey;
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, isoBase64URL.toBuffer(jwk.x ?? "")],
        [-3, isoBase64URL.toBuffer(jwk.y ?? "")],
      ]),
    );
    const rpIdHash = await sha256(utf8(options.rp.id ?? new URL(origin).hostname));
    const authData = concat(
      rpIdHash,
      Uint8Array.of(0x45), // UP | UV | AT
      counterBytes(0),
      new Uint8Array(16),
      Uint8Array.of(0, this.credentialId.length),
      this.credentialId,
      cose,
    );
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]) as never,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(
          this.clientData("webauthn.create", options.challenge, origin),
        ),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** Answers `navigator.credentials.get()`. `userVerified: false` simulates a presence-only tap. */
  async assert(
    options: { challenge: string; rpId?: string },
    { origin = ORIGIN, userVerified = true } = {},
  ) {
    const { privateKey } = await this.keyPair();
    this.signCount += 1;
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, origin);
    const authData = concat(
      await sha256(utf8(options.rpId ?? new URL(origin).hostname)),
      Uint8Array.of(userVerified ? 0x05 : 0x01),
      counterBytes(this.signCount),
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        concat(authData, await sha256(clientDataJSON)),
      ),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(rawToDer(signature)),
        userHandle: null,
      },
    };
  }
}
