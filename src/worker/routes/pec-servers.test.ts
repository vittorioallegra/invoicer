import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  setupOwner,
  signIn,
  TestClient,
  totpCode,
  VirtualAuthenticator,
} from "../auth/test-helpers";
import type { Bindings } from "../env";

const bindings = env as unknown as Bindings;
const device = new VirtualAuthenticator();
let owner: TestClient;

const servers = {
  imapHost: "imap.example.it",
  imapPort: 993,
  smtpHost: "smtp.example.it",
  smtpPort: 465,
};

interface Challenge {
  challengeId: string;
  options: { challenge: string; rpId: string };
}

const challenge = async (body: unknown) =>
  owner.json<Challenge>("/api/settings/pec-servers/challenge", { body });
const answerFor = async (c: Challenge) => ({
  challengeId: c.challengeId,
  passkey: (await device.assert({ challenge: c.options.challenge, rpId: c.options.rpId })) as never,
});
const put = (body: unknown) => owner.json("/api/settings/pec-servers", { method: "PUT", body });
const storedHost = async () =>
  (
    await env.DB.prepare("SELECT pec_imap_host AS h FROM settings WHERE id = 1").first<{
      h: string | null;
    }>()
  )?.h ?? null;

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.15.0.1", bindings));
  owner = new TestClient("10.15.0.2", bindings);
  await signIn(owner);
  const options = await owner.json<{ challenge: string; rp: { id: string } }>(
    "/api/auth/passkey/generate-register-options",
  );
  await owner.json("/api/auth/passkey/verify-registration", {
    body: { response: await device.register(options.body), name: "Test device" },
  });
  const enabled = await owner.json<{ totpURI: string }>("/api/auth/two-factor/enable", {
    body: { password: "a-long-test-password" },
  });
  await owner.json("/api/auth/two-factor/verify-totp", {
    body: { code: await totpCode(enabled.body.totpURI) },
  });
});

describe("PEC servers need the passkey", () => {
  it("needs a session", async () => {
    const anon = new TestClient("10.15.0.3", bindings);
    expect((await anon.json("/api/settings/pec-servers/challenge", { body: servers })).status).toBe(
      401,
    );
    expect(
      (await anon.json("/api/settings/pec-servers", { method: "PUT", body: servers })).status,
    ).toBe(401);
  });

  it("refuses a save without an answer, and stores nothing", async () => {
    expect((await put(servers)).status).toBe(400);
    expect(await storedHost()).toBeNull();
  });

  it("saves with a passkey answer bound to exactly these servers, once", async () => {
    const c = await challenge(servers);
    expect(c.status).toBe(200);
    const answer = await answerFor(c.body);
    // The answer was given for other servers: refused, and the challenge is used up.
    const other = await put({ ...servers, imapHost: "evil.example.com", answer });
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(await storedHost()).toBeNull();
    const c2 = await challenge(servers);
    const ok = await put({ ...servers, answer: await answerFor(c2.body) });
    expect(ok.status).toBe(200);
    expect(await storedHost()).toBe("imap.example.it");
    // Replaying the same answer fails.
    const replay = await put({ ...servers, imapPort: 994, answer: await answerFor(c2.body) });
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });

  it("does not accept the answer to a send challenge", async () => {
    await env.DB.prepare("INSERT INTO invoices (id, created_at) VALUES ('inv-x', 1)").run();
    const send = await owner.json<Challenge>("/api/invoices/inv-x/send-challenge", {
      body: { xmlSha256: "a".repeat(64) },
    });
    const res = await put({
      ...servers,
      imapHost: "imap2.example.it",
      answer: await answerFor(send.body),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await storedHost()).toBe("imap.example.it");
  });

  it("refuses IP addresses and internal names", async () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.5",
      "localhost",
      "mail",
      "mail.local",
      "db.internal",
    ]) {
      const res = await challenge({ ...servers, imapHost: host });
      expect(res.status, host).toBe(400);
    }
  });
});
