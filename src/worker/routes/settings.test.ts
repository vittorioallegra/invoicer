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
  regimeFiscale: "RF19",
  paymentDefaults: {
    iban: "IT60X0542811101000000123456",
    bic: "",
    accountHolder: "",
    bankName: "",
  },
  defaultPaymentTermsDays: 30,
};

const goodSession = () =>
  fakeSocket(GREETING, [
    { expect: `A1 LOGIN "${PEC_USERNAME}" "${PEC_PASSWORD}"`, reply: "A1 OK Logged in\r\n" },
    { expect: 'A2 EXAMINE "INBOX"', reply: EXAMINE_REPLY },
    { expect: "A3 LOGOUT", reply: "* BYE\r\nA3 OK done\r\n" },
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

beforeEach(() => {
  sockets.opened = 0;
  sockets.next = null;
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
      body: { ...profile, vatNumber: "123", regimeFiscale: "RF03" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toContain("vatNumber: invalid_vat_number");

    const saved = await owner.json<{ profile: { regimeFiscale: string; taxCode: null } }>(
      "/api/profile",
      { method: "PUT", body: profile },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.profile).toMatchObject({ regimeFiscale: "RF19", taxCode: null });

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

describe("invoice numbering", () => {
  const year = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric" }).format(
      new Date(),
    ),
  );
  const numbering = async () =>
    (
      await owner.json<{ invoiceNumber: { year: number; next: number; minimum: number } }>(
        "/api/settings",
      )
    ).body.invoiceNumber;

  it("starts at 1 for the current Rome year and continues from a chosen number", async () => {
    expect(await numbering()).toEqual({ year, next: 1, minimum: 1 });
    const set = await owner.json("/api/settings/invoice-number", {
      method: "PUT",
      body: { number: 18 },
    });
    expect(set.status).toBe(200);
    expect(await numbering()).toEqual({ year, next: 18, minimum: 1 });
  });

  it("refuses a number at or below one already used, and a non-integer", async () => {
    await env.DB.prepare(
      "INSERT INTO invoices (id, year, number_int, created_at) VALUES ('n7', ?, 7, 1)",
    )
      .bind(year)
      .run();
    // An invoice of another year does not count.
    await env.DB.prepare(
      "INSERT INTO invoices (id, year, number_int, created_at) VALUES ('old', ?, 99, 1)",
    )
      .bind(year - 1)
      .run();
    expect(await numbering()).toMatchObject({ minimum: 8 });
    const low = await owner.json<{ detail: string }>("/api/settings/invoice-number", {
      method: "PUT",
      body: { number: 7 },
    });
    expect(low.status).toBe(409);
    expect(low.body.detail).toContain("8");
    expect(
      (await owner.json("/api/settings/invoice-number", { method: "PUT", body: { number: 1.5 } }))
        .status,
    ).toBe(400);
    expect(
      (await owner.json("/api/settings/invoice-number", { method: "PUT", body: { number: 8 } }))
        .status,
    ).toBe(200);
    expect(await numbering()).toMatchObject({ next: 8 });
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

  it("stores a passing result (login, EXAMINE, logout; read-only) and opens the gate", async () => {
    const socket: FakeSocket = goodSession();
    sockets.next = socket;
    const res = await owner.json<{ ok: boolean; at: number }>("/api/settings/pec-test", {
      body: {},
    });
    expect(res.body.ok).toBe(true);
    expect(socket.received).toEqual([
      `A1 LOGIN "${PEC_USERNAME}" "${PEC_PASSWORD}"`,
      'A2 EXAMINE "INBOX"',
      "A3 LOGOUT",
    ]);
    const onboarding = (await owner.json<Onboarding>("/api/onboarding")).body;
    expect(onboarding.send).toEqual({ ready: true, reasons: [] });
    expect(onboarding.pecTest).toMatchObject({ ok: true, error: null });
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
