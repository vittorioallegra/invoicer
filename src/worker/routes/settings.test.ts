import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  setupOwner,
  signIn,
  TestClient,
  totpCode,
  VirtualAuthenticator,
} from "../auth/test-helpers";
import type { Bindings } from "../env";
import { loadSendReadiness } from "../onboarding";
import { type FakeSocket, fakeSocket } from "../pec/fake-socket";
import { EXAMINE_REPLY, GREETING } from "../pec/imap.fixtures";
import { type ConnectMailer, smtpDeps } from "../pec/smtp";
import { SMTP_ERRORS } from "../pec/smtp.fixtures";

const sockets = vi.hoisted(() => ({ next: null as unknown, opened: 0 }));
vi.mock("../pec/socket", () => ({
  connectImap: () => {
    sockets.opened++;
    if (sockets.next instanceof Error) throw sockets.next;
    return sockets.next;
  },
}));

const PEC_USERNAME = "owner@pec.example";
const PEC_PASSWORD = "s3cret-pw";
const bindings = { ...env, PEC_USERNAME, PEC_PASSWORD } as unknown as Bindings;

const profile = {
  name: "Mario Rossi",
  vatNumber: "12345678903",
  taxCode: "",
  address: "Via Roma 1",
  postalCode: "00100",
  city: "Roma",
  province: "RM",
  country: "IT",
};

const goodSession = () =>
  fakeSocket(GREETING, [
    { expect: `A1 LOGIN "${PEC_USERNAME}" "${PEC_PASSWORD}"`, reply: "A1 OK Logged in\r\n" },
    { expect: 'A2 EXAMINE "INBOX"', reply: EXAMINE_REPLY },
    {
      expect: 'A3 GETQUOTAROOT "INBOX"',
      reply: '* QUOTAROOT "INBOX" ""\r\n* QUOTA "" (STORAGE 12288 1048576)\r\nA3 OK done\r\n',
    },
    { expect: "A4 LOGOUT", reply: "* BYE\r\nA4 OK done\r\n" },
  ]);

let owner: TestClient;

interface Onboarding {
  checklist: { id: string; done: boolean }[];
  complete: boolean;
  send: { ready: boolean; reasons: string[] };
  pecTest: { ok: boolean; error: string | null } | null;
}
const doneIds = async () =>
  (await owner.json<Onboarding>("/api/onboarding")).body.checklist
    .filter((item) => item.done)
    .map((item) => item.id);

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.8.0.1", bindings));
  owner = new TestClient("10.8.0.2", bindings);
  await signIn(owner);
});

const smtp = { connects: 0, error: null as string | null };
const fakeMailer: ConnectMailer = async () => {
  smtp.connects++;
  if (smtp.error) throw new Error(smtp.error);
  return { send: async () => undefined, close: async () => undefined };
};

beforeEach(() => {
  sockets.opened = 0;
  sockets.next = null;
  smtp.connects = 0;
  smtp.error = null;
  smtpDeps.connect = fakeMailer;
});

describe("access", () => {
  it("needs a session on every route", async () => {
    const anon = new TestClient("10.8.1.1", bindings);
    for (const path of ["/api/profile", "/api/settings", "/api/onboarding"]) {
      expect((await anon.json(path)).status).toBe(401);
    }
    expect((await anon.json("/api/settings/pec-test", { body: {} })).status).toBe(401);
    expect(sockets.opened).toBe(0);
  });
});

describe("profile", () => {
  it("is empty at first, rejects bad fields with codes, then saves and updates one row", async () => {
    expect((await owner.json("/api/profile")).body).toEqual({ profile: null });

    const bad = await owner.json<{ detail: string }>("/api/profile", {
      method: "PUT",
      body: { ...profile, vatNumber: "123" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toContain("vatNumber: invalid_vat_number");

    const saved = await owner.json<{ profile: { regimeFiscale: string; taxCode: null } }>(
      "/api/profile",
      { method: "PUT", body: profile },
    );
    expect(saved.status).toBe(200);
    // The regime is not part of the Company form: a new row starts at the ordinary regime.
    expect(saved.body.profile).toMatchObject({ regimeFiscale: "RF01", taxCode: null });

    const contacts = await owner.json<{ profile: { email: string | null; phone: string | null } }>(
      "/api/profile",
      { method: "PUT", body: { ...profile, email: "info@studio.it", phone: "+39 06 1234567" } },
    );
    expect(contacts.body.profile).toMatchObject({
      email: "info@studio.it",
      phone: "+39 06 1234567",
    });
    const badPhone = await owner.json<{ detail: string }>("/api/profile", {
      method: "PUT",
      body: { ...profile, phone: "12" },
    });
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.detail).toContain("phone: invalid_phone_length");
    const cleared = await owner.json<{ profile: { email: null; phone: null } }>("/api/profile", {
      method: "PUT",
      body: profile,
    });
    expect(cleared.body.profile).toMatchObject({ email: null, phone: null });

    await owner.json("/api/profile", { method: "PUT", body: { ...profile, name: "Mario R." } });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n, name FROM profile").first<{
      n: number;
      name: string;
    }>();
    expect(row).toEqual({ n: 1, name: "Mario R." });
    expect(
      (await owner.json<{ profile: { name: string } }>("/api/profile")).body.profile.name,
    ).toBe("Mario R.");
  });
});

describe("email settings and AdE guide", () => {
  it("saves email settings, marks them configured and validates addresses", async () => {
    const bad = await owner.json("/api/settings/email", {
      method: "PUT",
      body: { senderName: "", senderAddress: "", replyTo: "nope", bcc: "", mode: "ask" },
    });
    expect(bad.status).toBe(400);
    expect(await doneIds()).not.toContain("email");

    const ok = await owner.json("/api/settings/email", {
      method: "PUT",
      body: {
        senderName: "",
        senderAddress: "",
        replyTo: "me@example.com",
        bcc: "",
        mode: "automatic",
      },
    });
    expect(ok.status).toBe(200);
    const { body } = await owner.json<{ email: Record<string, unknown> }>("/api/settings");
    expect(body.email).toMatchObject({
      replyTo: "me@example.com",
      mode: "automatic",
      senderName: null,
      defaultSenderName: "Mario R.",
      configured: true,
    });
    expect(await doneIds()).toContain("email");
  });

  it("persists the AdE guide confirmation and lets it be undone", async () => {
    await owner.json("/api/settings/ade-guide", { method: "PUT", body: { done: true } });
    expect(await doneIds()).toContain("ade_guide");
    await owner.json("/api/settings/ade-guide", { method: "PUT", body: { done: false } });
    expect(await doneIds()).not.toContain("ade_guide");
  });
});

describe("PEC connection test and the send gate", () => {
  it("blocks sending with reasons until the profile, credentials and a passing test exist", async () => {
    const before = (await owner.json<Onboarding>("/api/onboarding")).body;
    expect(before.send).toEqual({ ready: false, reasons: ["pec_test_missing"] });
    expect(before.pecTest).toBeNull();

    // No profile yet in a fresh database view: simulate by reading readiness without it.
    await env.DB.prepare("DELETE FROM profile").run();
    expect((await loadSendReadiness(bindings)).reasons).toEqual([
      "profile_incomplete",
      "pec_test_missing",
    ]);
    await owner.json("/api/profile", { method: "PUT", body: profile });
  });

  it("is ready on the mock channel without PEC secrets, through the onboarding API too", async () => {
    const mock = new TestClient("10.8.2.2", {
      ...env,
      PEC_USERNAME: "",
      PEC_PASSWORD: "",
      SEND_CHANNEL: "mock",
      APP_ORIGIN: "http://localhost",
    } as unknown as Bindings);
    await setupOwnerSession(mock);
    await mock.json("/api/profile", { method: "PUT", body: profile });
    expect((await mock.json<Onboarding>("/api/onboarding")).body.send).toEqual({
      ready: true,
      reasons: [],
    });
    // Production behaviour is unchanged: without the mock channel the same secrets gate sending.
    const real = { ...env, PEC_USERNAME: "", PEC_PASSWORD: "" } as unknown as Bindings;
    expect((await loadSendReadiness(real)).reasons).toEqual(["pec_credentials_missing"]);
  });

  it("names the missing secrets and opens no connection when they are unset", async () => {
    const client = new TestClient("10.8.2.1", {
      ...env,
      PEC_USERNAME: "",
      PEC_PASSWORD: "",
    } as unknown as Bindings);
    await setupOwnerSession(client);
    const res = await client.json<{ detail: string }>("/api/settings/pec-test", { body: {} });
    expect(res.status).toBe(503);
    expect(res.body.detail).toContain("PEC_USERNAME");
    expect(sockets.opened).toBe(0);
  });

  it("stores a passing result (IMAP login, EXAMINE, quota, SMTP login; nothing sent) and opens the gate", async () => {
    const socket: FakeSocket = goodSession();
    sockets.next = socket;
    const res = await owner.json<{
      ok: boolean;
      at: number;
      stages: Record<string, string>;
      quota: { usedKb: number; limitKb: number };
    }>("/api/settings/pec-test", { body: {} });
    expect(res.body.ok).toBe(true);
    expect(res.body.stages).toEqual({
      imapLogin: "ok",
      mailbox: "ok",
      quota: "ok",
      smtpLogin: "ok",
    });
    expect(res.body.quota).toEqual({ usedKb: 12288, limitKb: 1048576 });
    expect(smtp.connects).toBe(1);
    expect(socket.received).toEqual([
      `A1 LOGIN "${PEC_USERNAME}" "${PEC_PASSWORD}"`,
      'A2 EXAMINE "INBOX"',
      'A3 GETQUOTAROOT "INBOX"',
      "A4 LOGOUT",
    ]);
    const onboarding = (await owner.json<Onboarding>("/api/onboarding")).body;
    expect(onboarding.send).toEqual({ ready: true, reasons: [] });
    expect(onboarding.pecTest).toMatchObject({
      ok: true,
      error: null,
      quota: { usedKb: 12288, limitKb: 1048576 },
    });
    expect(await doneIds()).toContain("pec");
    expect((await loadSendReadiness(bindings)).ready).toBe(true);
  });

  it("stores a wrong-password failure, closes the gate, and leaks no secret anywhere", async () => {
    sockets.next = fakeSocket(GREETING, [
      { expect: /^A1 LOGIN/, reply: `A1 NO [AUTHENTICATIONFAILED] bad ${PEC_PASSWORD}\r\n` },
    ]);
    const res = await owner.json("/api/settings/pec-test", { body: {} });
    expect(res.body).toMatchObject({ ok: false, error: "login_failed" });
    expect((await owner.json<Onboarding>("/api/onboarding")).body.send.reasons).toEqual([
      "pec_test_failed",
    ]);

    const everything = JSON.stringify([
      res.body,
      (await owner.json("/api/settings")).body,
      (await owner.json("/api/onboarding")).body,
      (await env.DB.prepare("SELECT * FROM settings").all()).results,
    ]);
    expect(everything).not.toContain(PEC_PASSWORD);
    expect(everything).not.toContain(PEC_USERNAME);
  });

  it("reports the SMTP login stage on its own and keeps the secrets out", async () => {
    sockets.next = goodSession();
    smtp.error = `${SMTP_ERRORS.authFailed} ${PEC_PASSWORD}`;
    const res = await owner.json("/api/settings/pec-test", { body: {} });
    expect(res.body).toMatchObject({
      ok: false,
      error: "smtp_login_failed",
      stages: { imapLogin: "ok", mailbox: "ok", smtpLogin: "failed" },
    });
    expect(JSON.stringify(res.body)).not.toContain(PEC_PASSWORD);
    sockets.next = goodSession();
    smtp.error = SMTP_ERRORS.greeting;
    expect((await owner.json("/api/settings/pec-test", { body: {} })).body).toMatchObject({
      error: "smtp_connection_failed",
    });
  });

  it("works without QUOTA support", async () => {
    sockets.next = fakeSocket(GREETING, [
      { expect: /^A1 LOGIN/, reply: "A1 OK Logged in\r\n" },
      { expect: 'A2 EXAMINE "INBOX"', reply: EXAMINE_REPLY },
      { expect: /^A3 GETQUOTAROOT/, reply: "A3 BAD unknown command\r\n" },
      { expect: "A4 LOGOUT", reply: "* BYE\r\nA4 OK done\r\n" },
    ]);
    const res = await owner.json("/api/settings/pec-test", { body: {} });
    expect(res.body).toMatchObject({ ok: true, stages: { quota: "unsupported" } });
  });

  it("stores editable host and port presets, used by the test, with env as fallback", async () => {
    const before = (await owner.json<{ pec: { servers: { smtpHost: string } } }>("/api/settings"))
      .body.pec.servers;
    expect(before.smtpHost).toBe("smtps.pec.aruba.it");
    const bad = await owner.json("/api/settings/pec-servers", {
      method: "PUT",
      body: { imapHost: "bad host!", imapPort: 993, smtpHost: "smtp.example.it", smtpPort: 465 },
    });
    expect(bad.status).toBe(400);
    const saved = await owner.json<{ servers: { imapHost: string; smtpPort: number } }>(
      "/api/settings/pec-servers",
      {
        method: "PUT",
        body: {
          imapHost: "imap.example.it",
          imapPort: 1993,
          smtpHost: "smtp.example.it",
          smtpPort: 2465,
        },
      },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.servers).toMatchObject({ imapHost: "imap.example.it", smtpPort: 2465 });
    const opened: string[] = [];
    smtpDeps.connect = async (options) => {
      opened.push(`${options.host}:${options.port}`);
      return fakeMailer(options);
    };
    sockets.next = new Error("down");
    await owner.json("/api/settings/pec-test", { body: {} });
    expect(opened).toEqual(["smtp.example.it:2465"]);
    // A changed server clears the stored test, so the send gate asks for a new one.
    await owner.json("/api/settings/pec-servers", {
      method: "PUT",
      body: {
        imapHost: "imaps.pec.aruba.it",
        imapPort: 993,
        smtpHost: "smtps.pec.aruba.it",
        smtpPort: 465,
      },
    });
    expect((await loadSendReadiness(bindings)).reasons).toEqual(["pec_test_missing"]);
  });

  it("stores a connection failure when the server cannot be reached", async () => {
    sockets.next = new Error(`connect to imaps.pec.aruba.it failed for ${PEC_PASSWORD}`);
    const res = await owner.json("/api/settings/pec-test", { body: {} });
    expect(res.body).toMatchObject({ ok: false, error: "connection_failed" });
    expect(JSON.stringify(res.body)).not.toContain(PEC_PASSWORD);
  });
});

describe("checklist", () => {
  it("derives the passkey and fallback-login items from the account", async () => {
    expect(await doneIds()).not.toContain("passkey");
    expect(await doneIds()).not.toContain("fallback_login");

    const device = new VirtualAuthenticator();
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

    const done = await doneIds();
    expect(done).toEqual(expect.arrayContaining(["passkey", "fallback_login", "profile", "email"]));
  });
});

async function setupOwnerSession(client: TestClient) {
  // The owner already exists: sign in as them from a client that lacks the PEC secrets.
  await signIn(client);
}
