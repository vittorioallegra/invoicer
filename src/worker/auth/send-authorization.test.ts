import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { problemSchema } from "../../shared/errors";
import { type Bindings, pecCredentialStatus } from "../env";
import { type SendAnswer, verifySendAuthorization } from "./send-authorization";
import {
  applyMigrations,
  ORIGIN,
  setupOwner,
  signIn,
  TestClient,
  totpCode,
  VirtualAuthenticator,
} from "./test-helpers";

const PEC_USERNAME = "owner-secret-pec-login@pec.example.it";
const PEC_PASSWORD = "hunter2-very-secret-pec-password";
const bindings = { ...env, PEC_USERNAME, PEC_PASSWORD } as unknown as Bindings;

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const device = new VirtualAuthenticator();

interface Challenge {
  challengeId: string;
  options: { challenge: string; rpId: string; userVerification: string };
  passkeyAvailable: boolean;
  totpAvailable: boolean;
}

let owner: TestClient;
let userId: string;
let totpUri: string;

const challenge = async (invoiceId = "inv-1", xmlSha256 = HASH) => {
  const { status, body } = await owner.json<Challenge>(
    `/api/invoices/${invoiceId}/send-challenge`,
    {
      body: { xmlSha256 },
    },
  );
  expect(status).toBe(200);
  return body;
};

const verify = (answer: SendAnswer, invoiceId = "inv-1", xmlSha256 = HASH) =>
  verifySendAuthorization(
    bindings,
    new Request(`${ORIGIN}/api/invoices/${invoiceId}/send`, { headers: ownerHeaders() }),
    { userId, invoiceId, xmlSha256, answer },
  );

const ownerHeaders = () => ({ Cookie: owner.cookieHeader(), Origin: ORIGIN });

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.9.0.1", bindings));
  owner = new TestClient("10.9.0.2", bindings);
  await signIn(owner);
  userId = (await env.DB.prepare("SELECT id FROM user").first<{ id: string }>())?.id ?? "";

  const options = await owner.json<{ challenge: string; rp: { id: string } }>(
    "/api/auth/passkey/generate-register-options",
  );
  await owner.json("/api/auth/passkey/verify-registration", {
    body: { response: await device.register(options.body), name: "Test device" },
  });
  const enabled = await owner.json<{ totpURI: string }>("/api/auth/two-factor/enable", {
    body: { password: "a-long-test-password" },
  });
  totpUri = enabled.body.totpURI;
  await owner.json("/api/auth/two-factor/verify-totp", { body: { code: await totpCode(totpUri) } });
  await env.DB.prepare(
    "INSERT INTO invoices (id, created_at) VALUES ('inv-1', 1), ('inv-2', 1)",
  ).run();
});

afterEach(() => vi.restoreAllMocks());

const assertion = async (c: Challenge, opts?: { userVerified?: boolean }) => ({
  challengeId: c.challengeId,
  passkey: (await device.assert(
    { challenge: c.options.challenge, rpId: c.options.rpId },
    opts,
  )) as never,
});

describe("send challenge", () => {
  it("requires a session and an existing invoice and a well-formed hash", async () => {
    const anon = await new TestClient("10.9.1.1", bindings).json(
      "/api/invoices/inv-1/send-challenge",
      {
        body: { xmlSha256: HASH },
      },
    );
    expect(anon.status).toBe(401);
    const missing = await owner.json("/api/invoices/nope/send-challenge", {
      body: { xmlSha256: HASH },
    });
    expect(missing.status).toBe(404);
    const bad = await owner.json("/api/invoices/inv-1/send-challenge", {
      body: { xmlSha256: "xyz" },
    });
    expect(bad.status).toBe(400);
  });

  it("returns WebAuthn options requiring user verification, and stores a bound row", async () => {
    const c = await challenge();
    expect(c.options.userVerification).toBe("required");
    expect(c.passkeyAvailable).toBe(true);
    expect(c.totpAvailable).toBe(true);
    const row = await env.DB.prepare("SELECT * FROM send_challenges WHERE id = ?")
      .bind(c.challengeId)
      .first<{
        invoice_id: string;
        xml_sha256: string;
        challenge: string;
        used_at: number | null;
      }>();
    expect(row).toMatchObject({
      invoice_id: "inv-1",
      xml_sha256: HASH,
      challenge: c.options.challenge,
      used_at: null,
    });
  });
});

describe("passkey authorization", () => {
  it("accepts a valid assertion once and updates the counter", async () => {
    const c = await challenge();
    const answer = await assertion(c);
    expect(await verify(answer)).toEqual({ ok: true, method: "passkey" });
    const key = await env.DB.prepare("SELECT counter FROM passkey").first<{ counter: number }>();
    expect(key?.counter).toBeGreaterThan(0);
    // Replay of the very same answer.
    expect(await verify(answer)).toEqual({ ok: false, reason: "already_used" });
  });

  it("refuses an expired challenge", async () => {
    const c = await challenge();
    await env.DB.prepare("UPDATE send_challenges SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, c.challengeId)
      .run();
    expect(await verify(await assertion(c))).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses an answer for another invoice or another XML hash", async () => {
    const forInv1 = await challenge("inv-1", HASH);
    expect(await verify(await assertion(forInv1), "inv-2", HASH)).toEqual({
      ok: false,
      reason: "wrong_invoice",
    });
    const forHash = await challenge("inv-1", HASH);
    expect(await verify(await assertion(forHash), "inv-1", OTHER_HASH)).toEqual({
      ok: false,
      reason: "wrong_xml",
    });
  });

  it("refuses an unknown challenge, an assertion for another challenge, and no answer", async () => {
    expect(await verify({ challengeId: "unknown" })).toEqual({
      ok: false,
      reason: "unknown_challenge",
    });
    const first = await challenge();
    const second = await challenge();
    const stale = await assertion(first);
    expect(await verify({ ...stale, challengeId: second.challengeId })).toEqual({
      ok: false,
      reason: "invalid_passkey",
    });
    expect(await verify({ challengeId: (await challenge()).challengeId })).toEqual({
      ok: false,
      reason: "no_answer",
    });
  });

  it("refuses an assertion without user verification", async () => {
    const c = await challenge();
    expect(await verify(await assertion(c, { userVerified: false }))).toEqual({
      ok: false,
      reason: "invalid_passkey",
    });
  });

  it("refuses an unknown passkey", async () => {
    const c = await challenge();
    const stranger = new VirtualAuthenticator();
    const answer = {
      challengeId: c.challengeId,
      passkey: (await stranger.assert({
        challenge: c.options.challenge,
        rpId: c.options.rpId,
      })) as never,
    };
    expect(await verify(answer)).toEqual({ ok: false, reason: "invalid_passkey" });
  });
});

describe("TOTP fallback", () => {
  it("accepts a fresh code once and refuses a wrong one", async () => {
    const ok = await challenge();
    const code = await totpCode(totpUri);
    expect(await verify({ challengeId: ok.challengeId, totp: code })).toEqual({
      ok: true,
      method: "totp",
    });
    expect(await verify({ challengeId: ok.challengeId, totp: code })).toEqual({
      ok: false,
      reason: "already_used",
    });
    const bad = await challenge();
    expect(await verify({ challengeId: bad.challengeId, totp: "000000" })).toEqual({
      ok: false,
      reason: "invalid_totp",
    });
    // A failed guess burns the challenge: the right code on the same challenge is refused.
    expect(await verify({ challengeId: bad.challengeId, totp: code })).toEqual({
      ok: false,
      reason: "already_used",
    });
  });
});

describe("PEC credentials never leave the Worker (AC 4, part)", () => {
  it("appear in no API response and no log", async () => {
    const logs = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "info"),
    ];
    const bodies: string[] = [];
    const record = async (response: Response) => bodies.push(await response.text());

    await record(await owner.request("/api/features"));
    const c = await challenge();
    bodies.push(JSON.stringify(c));
    await record(
      await owner.request("/api/invoices/nope/send-challenge", { body: { xmlSha256: HASH } }),
    );
    await record(await owner.request("/api/invoices/inv-1/send-challenge", { body: {} }));
    await verify({ challengeId: c.challengeId, totp: "000000" });
    await record(await new TestClient("10.9.2.1", bindings).request("/api/features"));
    await record(
      await new TestClient("10.9.2.2", { ...bindings, PEC_PASSWORD: "" } as never).request(
        "/api/nope",
      ),
    );

    const features = await owner.json<{ pec: { username: boolean; password: boolean } }>(
      "/api/features",
    );
    expect(features.body.pec).toEqual({ username: true, password: true });
    expect(pecCredentialStatus({ ...bindings, PEC_USERNAME: "" })).toEqual({
      username: false,
      password: true,
    });

    const everything = JSON.stringify([bodies, logs.map((spy) => spy.mock.calls)]);
    expect(everything).not.toContain(PEC_PASSWORD);
    expect(everything).not.toContain(PEC_USERNAME);
    expect(problemSchema.safeParse(JSON.parse(bodies[1] ?? "{}")).success).toBe(false);
  });
});
