// Secrets audit (AC 4, full). One owner session drives every place a secret could leak and the
// test then searches everything that left or stayed behind: API responses (body and headers),
// D1 rows (BLOB files included), the data export, log lines, and what the browser would be told.
//
// protects=no Worker secret (PEC username and password, Resend key, VAPID private key, setup
// token, Better Auth secret) is copied into an API response, a D1 row, a stored message, the
// export or a log line, also when the IMAP server, the SMTP server, Resend or the push service
// echoes it back in an error; fails_when=any of those places holds a secret value, or the
// scenarios stop producing the failure paths they are meant to cover; no_claim=nothing about
// the Cloudflare dashboard or `wrangler tail` (they show the logs this test reads), about hashes
// of the owner's own password, or about mail addressed to the mailbox (a received message may
// name the PEC address in its own headers: that is mailbox content, not a copy of the login).
import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMPTY_CLIENT_DEFAULTS } from "../shared/client";
import { EMPTY_INVOICE_DATA } from "../shared/invoice";
import {
  applyMigrations,
  OWNER,
  setupOwner,
  signIn,
  TestClient,
  totpCode,
  VirtualAuthenticator,
} from "./auth/test-helpers";
import { resendDeps } from "./email/resend";
import type { Bindings } from "./env";
import { runScheduled } from "./jobs/scheduled";
import { type FakeMailbox, fakeMailbox } from "./pec/fake-mailbox";
import { fakeSocket } from "./pec/fake-socket";
import { EXAMINE_REPLY, GREETING } from "./pec/imap.fixtures";
import { pollDeps, pollMailbox } from "./pec/poll";
import { plainMail, receivedInvoiceMessage, sdiMessage } from "./pec/receipt-fixtures";
import { smtpDeps } from "./pec/smtp";
import { SMTP_ERRORS } from "./pec/smtp.fixtures";
import { pushDeps } from "./push/send";

const sockets = vi.hoisted(() => ({ next: null as unknown }));
vi.mock("./pec/socket", () => ({ connectImap: () => sockets.next }));

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** A real VAPID key pair: the private JWK is a secret, its public half is a plain var. */
async function vapidPair() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { privateJwk: JSON.stringify(jwk), privateD: jwk.d as string, publicKey: base64Url(raw) };
}

const SECRETS = {
  PEC_USERNAME: "audit-user.7f3a@pec.audit.invalid",
  PEC_PASSWORD: "AUDIT-pec-password-9c1e5b72d4",
  RESEND_API_KEY: "re_AUDIT_resend_key_4d2f8a61c0",
  SETUP_TOKEN: "AUDIT-setup-token-77ab31c9e2",
  BETTER_AUTH_SECRET: "AUDIT-better-auth-secret-0123456789abcdef-e6d1",
};
/** Every string that must never show up, with the common ways a secret gets re-encoded. */
let forbidden: { label: string; needle: string }[] = [];

let bindings: Bindings;
/** Everything the API returned (status line, headers and body), one entry per call. */
const seen: string[] = [];
/** Every console line the Worker code wrote. */
const logged: string[] = [];
const passkey = new VirtualAuthenticator();

class RecordingClient extends TestClient {
  override async request(...args: Parameters<TestClient["request"]>): Promise<Response> {
    const response = await super.request(...args);
    const headers = [...response.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
    seen.push(`${args[0]} -> ${response.status}\n${headers}\n${await response.clone().text()}`);
    return response;
  }
}

let owner: RecordingClient;
let clientId: string;

const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** An invoice with its XML (and optionally PDF) stored, ready to send. */
async function reservedInvoice(withPdf = false) {
  const created = await owner.json<{ invoice: { id: string } }>("/api/invoices", {
    body: {
      documentType: "TD01",
      clientId,
      currency: "EUR",
      invoiceDate: null,
      dueDate: null,
      linkedInvoiceId: null,
      lines: [
        {
          description: "Consulting",
          quantityMilli: 1000,
          unit: null,
          unitPriceCents: 10000,
          vatRateBp: 2200,
          natura: null,
        },
      ],
      data: EMPTY_INVOICE_DATA,
    },
  });
  const id = created.body.invoice.id;
  await owner.json(`/api/invoices/${id}/reserve-number`, { body: {} });
  const attempts = await owner.json<{ attempts: { fileName: string }[] }>(
    `/api/invoices/${id}/transmissions`,
  );
  const fileName = attempts.body.attempts.at(-1)?.fileName ?? "";
  const progressive = /_([A-Za-z0-9]+)\.xml$/.exec(fileName)?.[1];
  const xml = new TextEncoder().encode(
    `<?xml version="1.0"?><p:FatturaElettronica><ProgressivoInvio>${progressive}</ProgressivoInvio></p:FatturaElettronica>`,
  );
  await owner.json(`/api/invoices/${id}/xml`, {
    method: "PUT",
    body: xml,
    contentType: "application/xml",
  });
  if (withPdf) {
    await owner.json(`/api/invoices/${id}/pdf`, {
      method: "PUT",
      body: new TextEncoder().encode("%PDF-1.3\nAudit invoice"),
      contentType: "application/pdf",
    });
  }
  return { id, fileName, xml };
}

async function send(id: string, xml: Uint8Array) {
  const challenge = await owner.json<{
    challengeId: string;
    options: { challenge: string; rpId: string };
  }>(`/api/invoices/${id}/send-challenge`, { body: { xmlSha256: await sha256(xml) } });
  return owner.json<{ code?: string }>(`/api/invoices/${id}/send`, {
    body: {
      answer: {
        challengeId: challenge.body.challengeId,
        passkey: await passkey.assert({
          challenge: challenge.body.options.challenge,
          rpId: challenge.body.options.rpId,
        }),
      },
    },
  });
}

/** The words a server might echo into its error: the username, the password and a secret. */
const echo = (text: string) =>
  `${text} for ${SECRETS.PEC_USERNAME} password ${SECRETS.PEC_PASSWORD} key ${SECRETS.RESEND_API_KEY}`;

const echoingLoginRefusal = () =>
  fakeSocket(GREETING, [
    {
      expect: `A1 LOGIN "${SECRETS.PEC_USERNAME}" "${SECRETS.PEC_PASSWORD}"`,
      reply: `A1 NO [AUTHENTICATIONFAILED] ${echo("Invalid credentials")}\r\n`,
    },
  ]);

beforeAll(async () => {
  const vapid = await vapidPair();
  bindings = {
    ...env,
    ...SECRETS,
    VAPID_PRIVATE_KEY: vapid.privateJwk,
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_SUBJECT: "mailto:audit@example.invalid",
    MAIL_FROM_ADDRESS: "invoices@example.invalid",
    SEND_CHANNEL: "",
  } as unknown as Bindings;
  const values: Record<string, string> = {
    ...SECRETS,
    VAPID_PRIVATE_KEY: vapid.privateJwk,
    VAPID_PRIVATE_KEY_D: vapid.privateD,
  };
  forbidden = Object.entries(values).flatMap(([name, value]) => [
    { label: name, needle: value },
    { label: `${name} (base64)`, needle: btoa(value) },
    { label: `${name} (url-encoded)`, needle: encodeURIComponent(value) },
  ]);
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "),
      );
    });
  }

  await applyMigrations(env.DB);

  // First run: a wrong token and the right one (the response must not hint at the real value).
  const anonymous = new RecordingClient("10.9.0.1", bindings);
  expect(
    (await anonymous.json("/api/setup", { body: { token: "AUDIT-wrong-guess", ...OWNER } })).status,
  ).toBe(403);
  expect((await setupOwner(anonymous, SECRETS.SETUP_TOKEN)).status).toBe(201);
  expect((await setupOwner(anonymous, SECRETS.SETUP_TOKEN)).status).toBe(409);

  owner = new RecordingClient("10.9.0.2", bindings);
  expect((await signIn(owner, "not-the-password")).status).toBeGreaterThanOrEqual(400);
  await signIn(owner);
  const options = await owner.json<{ challenge: string; rp: { id: string } }>(
    "/api/auth/passkey/generate-register-options",
  );
  await owner.json("/api/auth/passkey/verify-registration", {
    body: { response: await passkey.register(options.body), name: "Audit device" },
  });
  const enabled = await owner.json<{ totpURI: string }>("/api/auth/two-factor/enable", {
    body: { password: OWNER.password },
  });
  await owner.json("/api/auth/two-factor/verify-totp", {
    body: { code: await totpCode(enabled.body.totpURI) },
  });

  await owner.json("/api/profile", {
    method: "PUT",
    body: {
      name: "Mario Rossi",
      vatNumber: "12345678903",
      taxCode: "",
      address: "Via Milano 2",
      postalCode: "20100",
      city: "Milano",
      province: "MI",
      country: "IT",
      regimeFiscale: "RF01",
      defaultPaymentTermsDays: null,
    },
  });
  await owner.json("/api/settings/email", {
    method: "PUT",
    body: {
      senderName: "Mario Rossi",
      senderAddress: "invoices@example.invalid",
      replyTo: "",
      bcc: "",
      mode: "automatic",
    },
  });
  clientId = (
    await owner.json<{ client: { id: string } }>("/api/clients", {
      body: {
        type: "it_company",
        name: "Acme S.r.l.",
        vatNumber: "12345678903",
        taxCode: "",
        foreignTaxId: "",
        countryCode: "IT",
        address: "Via Roma 1",
        postalCode: "00100",
        city: "Roma",
        province: "RM",
        recipientCode: "",
        pec: "",
        email: "acme@example.invalid",
        pdfLanguage: "en",
        currency: "EUR",
        defaults: EMPTY_CLIENT_DEFAULTS,
      },
    })
  ).body.client.id;
});

afterAll(() => vi.restoreAllMocks());

describe("failure paths that could echo a secret", () => {
  it("IMAP refuses the login and echoes the credentials: connection test and poll", async () => {
    sockets.next = echoingLoginRefusal();
    const test = await owner.json<{ ok: boolean; error: string }>("/api/settings/pec-test", {
      body: {},
    });
    expect(test.body).toMatchObject({ ok: false, error: "login_failed" });

    pollDeps.open = () => echoingLoginRefusal();
    expect(await pollMailbox(bindings)).toMatchObject({ ok: false, errorCode: "login_failed" });
  });

  it("SMTP refuses the login and echoes the credentials: connection test and send", async () => {
    sockets.next = fakeSocket(GREETING, [
      {
        expect: `A1 LOGIN "${SECRETS.PEC_USERNAME}" "${SECRETS.PEC_PASSWORD}"`,
        reply: "A1 OK Logged in\r\n",
      },
      { expect: 'A2 EXAMINE "INBOX"', reply: EXAMINE_REPLY },
      { expect: 'A3 GETQUOTAROOT "INBOX"', reply: "A3 NO [CANNOT] no quota\r\n" },
      { expect: "A4 LOGOUT", reply: "* BYE\r\nA4 OK done\r\n" },
    ]);
    smtpDeps.connect = async () => {
      throw new Error(echo(SMTP_ERRORS.authFailed));
    };
    const test = await owner.json<{ ok: boolean; error: string }>("/api/settings/pec-test", {
      body: {},
    });
    expect(test.body.ok).toBe(false);

    // The send gate wants a passed connection test; the fake send below needs none of the IMAP side.
    await env.DB.prepare(
      "INSERT INTO settings (id, pec_test_at, pec_test_ok) VALUES (1, ?, 1) ON CONFLICT(id) DO UPDATE SET pec_test_at = excluded.pec_test_at, pec_test_ok = 1",
    )
      .bind(Date.now())
      .run();
    const a = await reservedInvoice();
    const res = await send(a.id, a.xml);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("pec_auth_failed");
  });

  it("a missing secret names the variable, never a value", async () => {
    const without = new RecordingClient("10.9.0.3", { ...bindings, PEC_PASSWORD: "" } as Bindings);
    // Same session, on a Worker that lacks the secret.
    const res = await without.json<{ code: string; missing: string[] }>("/api/settings/pec-test", {
      body: {},
      headers: { Cookie: owner.cookieHeader() },
    });
    expect(res.body).toMatchObject({ code: "missing_secret", missing: ["PEC_PASSWORD"] });
  });

  it("a healthy mailbox is stored, and Resend rejecting the key does not echo it", async () => {
    smtpDeps.connect = async () => ({ send: async () => undefined, close: async () => undefined });
    const a = await reservedInvoice(true);
    expect((await send(a.id, a.xml)).status).toBe(200);

    const mailbox: FakeMailbox = {
      uidValidity: 77,
      messages: [
        { uid: 1, source: sdiMessage({ type: "RC", id: "audit-rc", fileName: a.fileName }) },
        { uid: 2, source: receivedInvoiceMessage({ id: "audit-inv" }) },
        { uid: 3, source: plainMail("audit-plain") },
      ],
    };
    pollDeps.open = () => fakeMailbox(mailbox);
    resendDeps.fetch = async () =>
      Response.json(
        { name: "invalid_api_key", message: echo("API key is invalid") },
        { status: 401 },
      );
    expect(await pollMailbox(bindings)).toMatchObject({ ok: true });

    // The same failure through the manual "Send email" action.
    const manual = await owner.json(`/api/invoices/${a.id}/courtesy-email`, {
      body: {
        requestId: "audit-manual-1",
        to: "acme@example.invalid",
        subject: "Invoice",
        body: "Please find the invoice attached.",
      },
    });
    expect(manual.status).toBe(502);
  });

  it("a push service that echoes the VAPID key does not leak it", async () => {
    const p256 = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", p256.publicKey)) as ArrayBuffer,
    );
    const subscribed = await owner.json("/api/push/subscriptions", {
      body: {
        endpoint: "https://push.example.invalid/audit-device",
        keys: {
          p256dh: base64Url(raw),
          auth: base64Url(crypto.getRandomValues(new Uint8Array(16))),
        },
      },
    });
    expect(subscribed.status).toBe(201);
    pushDeps.fetch = async () => new Response(echo("push rejected"), { status: 500 });
    await runScheduled(
      {
        cron: "*/10 * * * *",
        scheduledTime: Date.now(),
        noRetry() {},
      },
      bindings,
      async () => null,
    );
  });
});

describe("the audit looks at everything", () => {
  it("is not vacuous: the failure paths ran and left their traces", async () => {
    const codes = (
      await env.DB.prepare("SELECT error_code AS c FROM job_runs").all<{ c: string }>()
    ).results.map((r) => r.c);
    expect(codes).toContain("login_failed");
    expect(logged.some((line) => line.startsWith("poll_failed"))).toBe(true);
    const email = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_log").first<{
      n: number;
    }>();
    expect(email?.n).toBeGreaterThan(0);
  });

  it("no API response, header or body, holds a secret", async () => {
    // Read every list screen the app reads, after the scenarios above.
    for (const path of [
      "/api/features",
      "/api/onboarding",
      "/api/settings",
      "/api/profile",
      "/api/jobs",
      "/api/mailbox/status",
      "/api/mailbox/unmatched",
      "/api/notifications",
      "/api/push",
      "/api/clients",
      "/api/invoices?scope=all",
      "/api/received",
      "/api/payment-methods",
      "/api/numbering-series",
      "/api/tax",
    ]) {
      expect((await owner.request(path)).status, path).toBeLessThan(500);
    }
    const hits = forbidden.filter(({ needle }) => seen.some((entry) => entry.includes(needle)));
    expect(hits.map((h) => h.label)).toEqual([]);
    expect(seen.length).toBeGreaterThan(40);
  });

  it("no log line holds a secret", () => {
    expect(logged.length).toBeGreaterThan(0);
    const hits = forbidden.filter(({ needle }) => logged.some((line) => line.includes(needle)));
    expect(hits.map((h) => h.label)).toEqual([]);
  });

  it("no D1 row holds a secret: every table, files as text", async () => {
    const tables = (
      await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      ).all<{ name: string }>()
    ).results.map((r) => r.name);
    const asText = (value: unknown): string => {
      if (Array.isArray(value) && value.every((n) => typeof n === "number")) {
        return value.map((n) => String.fromCharCode(n)).join("");
      }
      return typeof value === "string" ? value : JSON.stringify(value);
    };
    const rows: string[] = [];
    for (const table of tables) {
      const { results } = await env.DB.prepare(`SELECT * FROM "${table}"`).all();
      for (const row of results) {
        rows.push(`${table}: ${Object.values(row).map(asText).join(" | ")}`);
      }
    }
    expect(tables).toEqual(
      expect.arrayContaining(["files", "pec_messages", "settings", "job_runs"]),
    );
    expect(rows.some((r) => r.startsWith("pec_messages:"))).toBe(true);
    const hits = forbidden.filter(({ needle }) => rows.some((row) => row.includes(needle)));
    expect(hits.map((h) => h.label)).toEqual([]);
  });

  it("the data export holds no secret", async () => {
    const res = await owner.request("/api/export");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(1000);
    const hits = forbidden.filter(({ needle }) => text.includes(needle));
    expect(hits.map((h) => h.label)).toEqual([]);
  });
});
