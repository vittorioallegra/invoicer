import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";
import { remindUnsentInvoices } from "../jobs/invoice-due";
import { runScheduled } from "../jobs/scheduled";
import { pollMailbox } from "../pec/poll";
import { plainMail, receivedInvoiceMessage, sdiMessage } from "../pec/receipt-fixtures";
import {
  PEC_PASSWORD,
  PEC_USERNAME,
  resetPolling,
  seedInvoice,
  useMailbox,
} from "../pec/test-support";
import { PUSH_BATCH_SIZE, processPushNotifications, pushPayload } from "./deliver";
import { pushDeps } from "./send";

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

async function vapid() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ])) as CryptoKeyPair;
  const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
  return jwk;
}

/** A real P-256 public key and auth secret, as a browser would hand them over. */
async function deviceKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { p256dh: base64Url(raw), auth: base64Url(crypto.getRandomValues(new Uint8Array(16))) };
}

let bindings: Bindings;
/** Signed in, on a Worker with the VAPID secrets. */
let owner: TestClient;
/** Signed in, on a Worker without them. */
let plain: TestClient;
let calls: { endpoint: string; headers: Record<string, string> }[] = [];
let answer: (endpoint: string) => number = () => 201;
const realFetch = pushDeps.fetch;

const one = async <T>(sql: string, ...bind: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...bind)
    .first<T>()) as T;
const unsettled = async () =>
  (await one<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE push_sent_at IS NULL"))
    .n;

async function subscribe(name: string) {
  const res = await owner.json("/api/push/subscriptions", {
    body: { endpoint: `https://push.example.test/${name}`, keys: await deviceKeys() },
  });
  expect(res.status).toBe(201);
}

async function notify(
  type: string,
  body: object,
  invoiceId: string | null = null,
  at = Date.now(),
) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO notifications (id, type, title, body, invoice_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, type, `notifications.${type}.title`, JSON.stringify(body), invoiceId, at)
    .run();
  return id;
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.8.0.1", env as unknown as Bindings));
  bindings = {
    ...env,
    PEC_USERNAME,
    PEC_PASSWORD,
    VAPID_PRIVATE_KEY: await vapid(),
    VAPID_PUBLIC_KEY: "public-key-placeholder",
    VAPID_SUBJECT: "mailto:owner@example.test",
  } as unknown as Bindings;
  owner = new TestClient("10.8.0.2", bindings);
  await signIn(owner);
  plain = new TestClient("10.8.0.6", env as unknown as Bindings);
  await signIn(plain);
});
beforeEach(async () => {
  calls = [];
  answer = () => 201;
  pushDeps.fetch = async (url, init) => {
    calls.push({ endpoint: url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    return new Response(null, { status: answer(url) });
  };
  await resetPolling(env.DB);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM push_subscriptions"),
    env.DB.prepare("UPDATE settings SET ui_language = NULL, push_disabled_types = NULL"),
  ]);
});
afterEach(() => {
  pushDeps.fetch = realFetch;
});

describe("push subscriptions API", () => {
  it("needs a session and the VAPID secrets", async () => {
    const body = { endpoint: "https://push.example.test/a", keys: await deviceKeys() };
    const anon = await new TestClient("10.8.0.3", bindings).json("/api/push/subscriptions", {
      body,
    });
    expect(anon.status).toBe(401);
    // The test Worker has no VAPID secrets: the call names them and the fix.
    const res = await plain.json<{ code: string; missing: string[]; fix: string }>(
      "/api/push/subscriptions",
      { body },
    );
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "missing_secret" });
    expect(res.body.missing).toContain("VAPID_PRIVATE_KEY");
    expect(res.body.fix).toContain("wrangler secret put VAPID_PRIVATE_KEY");
  });

  it("stores, refreshes and removes a device; rejects a non-https endpoint", async () => {
    const client = owner;
    const keys = await deviceKeys();
    const bad = await client.json("/api/push/subscriptions", {
      body: { endpoint: "http://push.example.test/a", keys },
    });
    expect(bad.status).toBe(400);
    for (let i = 0; i < 2; i++) {
      const res = await client.json("/api/push/subscriptions", {
        body: { endpoint: "https://push.example.test/a", keys },
      });
      expect(res.status).toBe(201);
    }
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions")).n).toBe(1);
    const state = await client.json<{ configured: boolean; devices: number }>("/api/push");
    expect(state.body).toMatchObject({ configured: true, devices: 1 });
    const gone = await client.json("/api/push/subscriptions", {
      method: "DELETE",
      body: { endpoint: "https://push.example.test/a" },
    });
    expect(gone.status).toBe(204);
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions")).n).toBe(0);
  });

  it("keeps the newest five devices", async () => {
    const client = owner;
    for (let i = 0; i < 7; i++) {
      await client.json("/api/push/subscriptions", {
        body: { endpoint: `https://push.example.test/d${i}`, keys: await deviceKeys() },
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    const rows = await env.DB.prepare("SELECT endpoint FROM push_subscriptions").all();
    expect(rows.results).toHaveLength(5);
  });

  it("stores per-type toggles and the language, and refuses unknown types", async () => {
    const ok = await owner.json("/api/push/types", {
      method: "PUT",
      body: { disabled: ["invoice_due", "invoice_due", "poll_failed"] },
    });
    expect(ok.body).toEqual({ disabledTypes: ["invoice_due", "poll_failed"] });
    expect((await owner.json<{ disabledTypes: string[] }>("/api/push")).body.disabledTypes).toEqual(
      ["invoice_due", "poll_failed"],
    );
    const bad = await owner.json("/api/push/types", { method: "PUT", body: { disabled: ["x"] } });
    expect(bad.status).toBe(400);
    const lang = await owner.json("/api/settings/language", {
      method: "PUT",
      body: { language: "it" },
    });
    expect(lang.status).toBe(200);
    expect((await one<{ l: string }>("SELECT ui_language AS l FROM settings")).l).toBe("it");
  });
});

describe("AC 15 (push parts, mocked push service)", () => {
  beforeEach(async () => {
    await subscribe("iphone");
    await subscribe("mac");
  });

  it("pushes an SdI outcome from the poll to every device, once", async () => {
    const inv = await seedInvoice(env.DB, {
      attempts: [{ fileName: "IT01234567890_0000A.xml", messageId: "<out@pec.example>" }],
    });
    useMailbox([
      {
        uid: 1,
        source: sdiMessage({ type: "RC", id: "rc1", fileName: "IT01234567890_0000A.xml" }),
      },
    ]);
    await pollMailbox(bindings);
    expect(await unsettled()).toBe(1);
    await runScheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now() } as ScheduledController,
      bindings,
      async () => new Date().toISOString().slice(0, 10),
    );
    expect(calls.map((c) => c.endpoint).sort()).toEqual([
      "https://push.example.test/iphone",
      "https://push.example.test/mac",
    ]);
    expect(calls[0]?.headers.authorization).toMatch(/vapid/i);
    expect(await unsettled()).toBe(0);
    // Settled rows are never pushed again.
    expect(await processPushNotifications(bindings)).toBe(0);
    expect(calls).toHaveLength(2);
    const row = await one<{ id: string; invoiceId: string }>(
      "SELECT id, invoice_id AS invoiceId FROM notifications",
    );
    expect(row.invoiceId).toBe(inv.id);
  });

  it("pushes a received invoice from the poll", async () => {
    const server = useMailbox([{ uid: 1, source: plainMail("seed") }]);
    await pollMailbox(bindings);
    await env.DB.prepare("DELETE FROM notifications").run();
    server.add({
      uid: 2,
      source: receivedInvoiceMessage({
        id: "i1",
        content:
          '<?xml version="1.0"?><p:FatturaElettronica versione="FPR12"><x>1</x></p:FatturaElettronica>',
      }),
    });
    await pollMailbox(bindings);
    expect(await processPushNotifications(bindings)).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("pushes the unsent-invoice reminder from the daily job", async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO clients (id, type, name, country_code, created_at)
       VALUES ('c1', 'it_company', 'Acme S.r.l.', 'IT', 1)`,
    ).run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO invoices (id, state, planned_date, client_id, created_at)
       VALUES ('inv-due', 'draft', '2026-06-10', 'c1', 1)`,
    ).run();
    const now = new Date("2026-06-10T07:00:00Z");
    expect(await remindUnsentInvoices(bindings, now)).toBe(1);
    expect(await processPushNotifications(bindings, now.getTime())).toBe(1);
    expect(calls).toHaveLength(2);
    await env.DB.prepare("DELETE FROM notifications").run();
    await env.DB.prepare("DELETE FROM invoices WHERE id = 'inv-due'").run();
  });

  it("writes the text in the owner's language and links to the invoice or the right list", () => {
    const invoice = pushPayload("it", {
      id: "n1",
      type: "invoice_rejected",
      body: JSON.stringify({ number: "7/2026" }),
      invoiceId: "inv-1",
    });
    expect(invoice).toMatchObject({ tag: "n1", url: "/invoices/inv-1" });
    expect(invoice.title).not.toContain("notifications.");
    expect(invoice.body).toContain("7/2026");
    expect(invoice.body).not.toContain("{{");
    const english = pushPayload("en", {
      id: "n2",
      type: "invoice_rejected",
      body: JSON.stringify({ number: "7/2026" }),
      invoiceId: "inv-1",
    });
    expect(english.title).toBe("Invoice rejected");
    expect(english.title).not.toBe(invoice.title);
    expect(
      pushPayload("en", {
        id: "n3",
        type: "received_invoice",
        body: '{"file":"a.xml"}',
        invoiceId: null,
      }).url,
    ).toBe("/received");
    expect(
      pushPayload("en", { id: "n4", type: "poll_failed", body: '{"code":"x"}', invoiceId: null })
        .url,
    ).toBe("/notifications");
    // The courtesy email offer opens the invoice, where the offer card lives.
    expect(
      pushPayload("en", {
        id: "n5",
        type: "courtesy_email_ask",
        body: '{"number":"1","client":"Acme"}',
        invoiceId: "inv-2",
      }).url,
    ).toBe("/invoices/inv-2");
  });

  it("skips types switched off and settles them", async () => {
    await owner.json("/api/push/types", { method: "PUT", body: { disabled: ["poll_failed"] } });
    await notify("poll_failed", { code: "login_failed" });
    expect(await processPushNotifications(bindings)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(await unsettled()).toBe(0);
  });

  it("removes expired devices (404/410) and still settles", async () => {
    answer = (endpoint) => (endpoint.endsWith("/mac") ? 410 : 201);
    await notify("received_invoice", { file: "a.xml" });
    expect(await processPushNotifications(bindings)).toBe(1);
    const left = await env.DB.prepare("SELECT endpoint FROM push_subscriptions").all();
    expect(left.results).toEqual([{ endpoint: "https://push.example.test/iphone" }]);
  });

  it("retries when every push service fails, and settles when no device is left", async () => {
    answer = () => 503;
    await notify("received_invoice", { file: "a.xml" });
    expect(await processPushNotifications(bindings)).toBe(0);
    expect(await unsettled()).toBe(1);
    answer = () => 201;
    expect(await processPushNotifications(bindings)).toBe(1);
    await notify("received_invoice", { file: "b.xml" });
    answer = () => 404;
    expect(await processPushNotifications(bindings)).toBe(1);
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions")).n).toBe(0);
  });

  it("bounds the work per tick and drops notifications older than an hour", async () => {
    const now = Date.now();
    for (let i = 0; i < PUSH_BATCH_SIZE + 2; i++)
      await notify("received_invoice", { file: `${i}.xml` });
    await notify("received_invoice", { file: "old.xml" }, null, now - 2 * 60 * 60 * 1000);
    expect(await processPushNotifications(bindings, now)).toBe(PUSH_BATCH_SIZE);
    expect(await processPushNotifications(bindings, now)).toBe(2);
    expect(await processPushNotifications(bindings, now)).toBe(0);
    expect(calls).toHaveLength((PUSH_BATCH_SIZE + 2) * 2);
  });

  it("does nothing while the VAPID keys are not configured", async () => {
    await notify("received_invoice", { file: "a.xml" });
    const off = { ...bindings, VAPID_PRIVATE_KEY: undefined } as unknown as Bindings;
    expect(await processPushNotifications(off)).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("notifications API", () => {
  it("lists newest first with a link, counts unread and marks read", async () => {
    await env.DB.prepare("INSERT INTO invoices (id, created_at) VALUES ('inv-1', 1)").run();
    const a = await notify("courtesy_email_ask", { number: "1", client: "Acme" }, "inv-1", 1000);
    await notify("poll_failed", { code: "login_failed" }, null, 2000);
    const list = await owner.json<{
      unread: number;
      notifications: { id: string; type: string; path: string; readAt: number | null }[];
    }>("/api/notifications");
    expect(list.body.unread).toBe(2);
    expect(list.body.notifications.map((n) => [n.type, n.path])).toEqual([
      ["poll_failed", "/notifications"],
      ["courtesy_email_ask", "/invoices/inv-1"],
    ]);
    await owner.json("/api/notifications/read", { body: { ids: [a] } });
    expect((await owner.json<{ unread: number }>("/api/notifications")).body.unread).toBe(1);
    await owner.json("/api/notifications/read", { body: {} });
    expect((await owner.json<{ unread: number }>("/api/notifications")).body.unread).toBe(0);
    await env.DB.prepare("DELETE FROM notifications").run();
    await env.DB.prepare("DELETE FROM invoices WHERE id = 'inv-1'").run();
  });
});
