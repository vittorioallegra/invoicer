import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";
import { pollMailbox } from "../pec/poll";
import { sdiMessage } from "../pec/receipt-fixtures";
import { resetPolling, seedInvoice, useMailbox } from "../pec/test-support";
import { processEmailOutbox } from "./deliver";
import { resendDeps } from "./resend";

const FILE = "IT01234567890_0000A.xml";
const FILE_B = "IT01234567890_0000B.xml";
const PDF_TEXT = "%PDF-1.3 courtesy test";
const bindings = {
  ...env,
  PEC_USERNAME: "owner@pec.example",
  PEC_PASSWORD: "pw",
  RESEND_API_KEY: "re_test_key",
} as unknown as Bindings;

interface Sent {
  headers: Record<string, string>;
  body: {
    from: string;
    to: string[];
    bcc?: string[];
    reply_to?: string;
    subject: string;
    text: string;
    attachments: { filename: string; content: string }[];
  };
}

let sent: Sent[] = [];
let reply: () => Response = () => Response.json({ id: `msg-${sent.length}` });
const realFetch = resendDeps.fetch;

const one = async <T>(sql: string, ...bind: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...bind)
    .first<T>()) as T;
const all = async <T>(sql: string, ...bind: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...bind)
      .all<T>()
  ).results;

async function configure(mode: "automatic" | "ask" | "off", extra: Record<string, unknown> = {}) {
  await env.DB.prepare(
    `INSERT INTO settings (id, email_sender_name, email_sender_address, email_reply_to, email_bcc,
       courtesy_email_mode, email_configured_at)
     VALUES (1, 'Mario Rossi', 'no-reply@example.test', 'mario@example.test', 'owner@example.test', ?, ?)
     ON CONFLICT(id) DO UPDATE SET email_sender_name = excluded.email_sender_name,
       email_sender_address = excluded.email_sender_address, email_reply_to = excluded.email_reply_to,
       email_bcc = excluded.email_bcc, courtesy_email_mode = excluded.courtesy_email_mode,
       email_configured_at = excluded.email_configured_at`,
  )
    .bind(mode, (extra.configuredAt as number | undefined) ?? 1)
    .run();
}

/** A sent invoice with its stored PDF and XML and a client who has a courtesy address. */
async function sentInvoice(
  o: { clientEmail?: string | null; language?: "it" | "en"; fileName?: string } = {},
) {
  const inv = await seedInvoice(env.DB, {
    attempts: [{ fileName: o.fileName ?? FILE, messageId: "<out-1@pec.example>" }],
  });
  const clientId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO clients (id, type, name, email, pdf_language, created_at) VALUES (?, 'it_company', 'Acme S.r.l.', ?, ?, 1)",
  )
    .bind(
      clientId,
      o.clientEmail === undefined ? "billing@acme.test" : o.clientEmail,
      o.language ?? "en",
    )
    .run();
  await env.DB.prepare(
    `UPDATE invoices SET client_id = ?, issue_date = '2026-03-10', due_date = '2026-04-09',
       total_cents = 122000, number_raw = 'CH-3' WHERE id = ?`,
  )
    .bind(clientId, inv.id)
    .run();
  const file = (kind: string, name: string, type: string, text: string) => {
    const id = crypto.randomUUID();
    return env.DB.prepare(
      `INSERT INTO files (id, kind, invoice_id, transmission_id, filename, content_type, size, sha256, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'x', ?, 1)`,
    )
      .bind(
        id,
        kind,
        inv.id,
        inv.transmissionIds[0],
        name,
        type,
        text.length,
        new TextEncoder().encode(text),
      )
      .run()
      .then(() => id);
  };
  const pdfId = await file("pdf", "stored-name.pdf", "application/pdf", PDF_TEXT);
  const xmlId = await file("xml", FILE, "application/xml", "<xml/>");
  await env.DB.prepare("UPDATE transmissions SET pdf_file_id = ?, xml_file_id = ? WHERE id = ?")
    .bind(pdfId, xmlId, inv.transmissionIds[0])
    .run();
  return inv;
}

// Not a React hook: an alias keeps the hooks lint rule quiet inside a plain helper.
const pointAtMailbox = useMailbox;

const receipt = (type: "RC" | "MC", id: string) => sdiMessage({ type, id, fileName: FILE });

beforeAll(async () => {
  await applyMigrations(env.DB);
});
beforeEach(async () => {
  sent = [];
  reply = () => Response.json({ id: `msg-${sent.length}` });
  resendDeps.fetch = async (_url, init) => {
    sent.push({
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    });
    return reply();
  };
  await env.DB.prepare("DELETE FROM email_log").run();
  await env.DB.prepare("UPDATE transmissions SET pdf_file_id = NULL, xml_file_id = NULL").run();
  await resetPolling(env.DB);
  await env.DB.prepare("DELETE FROM clients").run();
});
afterEach(() => {
  resendDeps.fetch = realFetch;
});

describe("AC 14: automatic mode sends exactly one courtesy email per outcome", () => {
  it("sends one email on delivered and one on not_delivered, with PDF, XML, From, Reply-To and BCC", async () => {
    await configure("automatic");
    const delivered = await sentInvoice();
    const notDelivered = await sentInvoice({ language: "it", fileName: FILE_B });
    const server = useMailbox([
      { uid: 1, source: receipt("RC", "rc-1") },
      {
        uid: 2,
        source: sdiMessage({ type: "MC", id: "mc-1", fileName: FILE_B }),
      },
    ]);
    await pollMailbox(bindings);

    expect(sent).toHaveLength(2);
    const byTo = sent.map((s) => s.body);
    for (const body of byTo) {
      expect(body.from).toBe('"Mario Rossi" <no-reply@example.test>');
      expect(body.to).toEqual(["billing@acme.test"]);
      expect(body.reply_to).toBe("mario@example.test");
      expect(body.bcc).toEqual(["owner@example.test"]);
      expect(body.attachments.map((a) => a.filename)).toEqual([
        "invoice-CH-3-acme-s-r-l.pdf",
        FILE,
      ]);
      expect(atob(body.attachments[0]?.content ?? "")).toBe(PDF_TEXT);
    }
    // English client for the delivered invoice, Italian for the other; only the latter points to AdE.
    expect(sent.filter((s) => s.body.subject.startsWith("Invoice CH-3"))).toHaveLength(1);
    expect(sent.filter((s) => s.body.text.includes("Fatture e Corrispettivi"))).toHaveLength(1);
    expect(sent.every((s) => s.headers.Authorization === "Bearer re_test_key")).toBe(true);
    expect(sent.every((s) => /^outbox-/.test(s.headers["Idempotency-Key"] ?? ""))).toBe(true);

    expect(
      (
        await all<{ status: string; trigger: string; invoice_id: string }>(
          "SELECT status, trigger, invoice_id FROM email_log",
        )
      ).map((r) => [r.status, r.trigger]),
    ).toEqual([
      ["sent", "automatic"],
      ["sent", "automatic"],
    ]);
    expect(
      (await all<{ status: string }>("SELECT status FROM outbox WHERE kind = 'email'")).map(
        (r) => r.status,
      ),
    ).toEqual(["sent", "sent"]);
    expect(delivered.id).not.toBe(notDelivered.id);

    // A later run (or a replayed message) sends nothing more.
    await processEmailOutbox(bindings);
    await pollMailbox(bindings);
    expect(sent).toHaveLength(2);
    expect(server.mailbox.messages).toHaveLength(2);
  });

  it("retries a send that crashed after the outbox row was claimed with the same Idempotency-Key", async () => {
    await configure("automatic");
    const inv = await sentInvoice();
    await env.DB.prepare(
      "INSERT INTO outbox (id, invoice_id, attempt, kind, payload, status, created_at) VALUES ('ob-1', ?, 1, 'email', '{}', 'pending', ?)",
    )
      .bind(inv.id, Date.now())
      .run();
    // The first try dies before the log row is written (provider answered, D1 batch lost).
    await env.DB.exec(
      "CREATE TRIGGER no_log BEFORE INSERT ON email_log BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    await processEmailOutbox(bindings);
    await env.DB.exec("DROP TRIGGER no_log");
    expect((await one<{ status: string }>("SELECT status FROM outbox")).status).toBe("pending");
    await processEmailOutbox(bindings);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.headers["Idempotency-Key"]).toBe("outbox-ob-1");
    expect(sent[1]?.headers["Idempotency-Key"]).toBe("outbox-ob-1");
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM email_log")).n).toBe(1);
  });
});

describe("rows that are not sent", () => {
  const queue = async (invoiceId: string, createdAt = Date.now()) => {
    await env.DB.prepare(
      "INSERT INTO outbox (id, invoice_id, attempt, kind, payload, status, created_at) VALUES (?, ?, 1, 'email', '{}', 'pending', ?)",
    )
      .bind(crypto.randomUUID(), invoiceId, createdAt)
      .run();
  };
  const outbox = () =>
    one<{ status: string; error: string | null }>("SELECT status, error FROM outbox");

  it("skips when the mode is off", async () => {
    await configure("off");
    await queue((await sentInvoice()).id);
    await processEmailOutbox(bindings);
    expect(await outbox()).toEqual({ status: "skipped", error: "off" });
    expect(sent).toHaveLength(0);
  });

  it("skips rows queued before the courtesy email was configured", async () => {
    await queue((await sentInvoice()).id, 1000);
    await processEmailOutbox(bindings);
    expect(await outbox()).toEqual({ status: "skipped", error: "not_configured" });
    await configure("automatic", { configuredAt: Date.now() + 60_000 });
    await env.DB.prepare("UPDATE outbox SET status = 'pending', error = NULL").run();
    await processEmailOutbox(bindings);
    expect(await outbox()).toEqual({ status: "skipped", error: "before_enabled" });
    expect(sent).toHaveLength(0);
  });

  it("skips without the Resend key or without a recipient", async () => {
    await configure("automatic");
    await queue((await sentInvoice()).id);
    await processEmailOutbox({ ...bindings, RESEND_API_KEY: undefined } as Bindings);
    expect(await outbox()).toEqual({ status: "skipped", error: "not_configured" });
    await env.DB.prepare("DELETE FROM outbox").run();
    await queue((await sentInvoice({ clientEmail: null, fileName: FILE_B })).id);
    await processEmailOutbox(bindings);
    expect(await outbox()).toEqual({ status: "skipped", error: "no_recipient" });
    expect(sent).toHaveLength(0);
  });
});

describe("failure", () => {
  it("logs it, raises a notification and does not retry on its own", async () => {
    await configure("automatic");
    const inv = await sentInvoice();
    useMailbox([{ uid: 1, source: receipt("RC", "rc-f") }]);
    reply = () => Response.json({ name: "validation_error", message: "bad" }, { status: 422 });
    await pollMailbox(bindings);
    await pollMailbox(bindings);
    expect(sent).toHaveLength(1);
    expect(await one("SELECT status, error, trigger FROM email_log")).toEqual({
      status: "failed",
      error: "resend_422_validation_error",
      trigger: "automatic",
    });
    expect(await one("SELECT status, error FROM outbox WHERE kind = 'email'")).toMatchObject({
      status: "failed",
    });
    const note = await one<{ type: string; invoice_id: string; body: string }>(
      "SELECT type, invoice_id, body FROM notifications WHERE type = 'courtesy_email_failed'",
    );
    expect(note.invoice_id).toBe(inv.id);
    expect(JSON.parse(note.body)).toMatchObject({ number: "CH-3", recipient: "billing@acme.test" });
  });

  it("records an unreachable provider as a failure", async () => {
    await configure("automatic");
    await sentInvoice();
    useMailbox([{ uid: 1, source: receipt("RC", "rc-u") }]);
    resendDeps.fetch = async () => {
      throw new TypeError("network");
    };
    await pollMailbox(bindings);
    expect((await one<{ error: string }>("SELECT error FROM email_log")).error).toBe(
      "resend_unreachable",
    );
  });
});

describe("ask mode and the manual send", () => {
  let owner: TestClient;
  beforeAll(async () => {
    await setupOwner(new TestClient("10.14.0.1", bindings));
    owner = new TestClient("10.14.0.2", bindings);
    await signIn(owner);
  });

  type Overview = {
    draft: {
      to: string;
      subject: string;
      body: string;
      attachments: { filename: string }[];
    } | null;
    ask: { id: string; attempt: number } | null;
    ready: boolean;
    log: { status: string; trigger: string; recipient: string; error: string | null }[];
  };
  const overview = async (id: string) =>
    (await owner.json<Overview>(`/api/invoices/${id}/courtesy-email`)).body;
  const post = (id: string, body: Record<string, unknown>) =>
    owner.json(`/api/invoices/${id}/courtesy-email`, {
      body: {
        requestId: crypto.randomUUID(),
        to: "billing@acme.test",
        subject: "Edited subject",
        body: "Edited body",
        ...body,
      },
    });

  async function asked() {
    await configure("ask");
    const inv = await sentInvoice();
    pointAtMailbox([{ uid: 1, source: receipt("RC", "rc-a") }]);
    await pollMailbox(bindings);
    return inv;
  }

  it("proposes the email instead of sending it, then sends the edited text on Send", async () => {
    const inv = await asked();
    expect(sent).toHaveLength(0);
    expect(
      (await one<{ status: string }>("SELECT status FROM outbox WHERE kind = 'email'")).status,
    ).toBe("asked");
    expect(
      await one("SELECT type, invoice_id FROM notifications WHERE type = 'courtesy_email_ask'"),
    ).toEqual({
      type: "courtesy_email_ask",
      invoice_id: inv.id,
    });
    const view = await overview(inv.id);
    expect(view.ask?.attempt).toBe(1);
    expect(view.draft?.to).toBe("billing@acme.test");
    expect(view.draft?.subject).toBe("Invoice CH-3 from Mario Rossi");
    expect(view.draft?.attachments.map((a) => a.filename)).toEqual([
      "invoice-CH-3-acme-s-r-l.pdf",
      FILE,
    ]);

    const answer = await post(inv.id, { outboxId: view.ask?.id, to: "other@acme.test" });
    expect(answer.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      to: ["other@acme.test"],
      subject: "Edited subject",
      text: "Edited body",
    });
    const after = await overview(inv.id);
    expect(after.ask).toBeNull();
    expect(after.log.map((l) => [l.status, l.trigger, l.recipient])).toEqual([
      ["sent", "ask", "other@acme.test"],
    ]);
    expect(
      (
        await one<{ read_at: number | null }>(
          "SELECT read_at FROM notifications WHERE type = 'courtesy_email_ask'",
        )
      ).read_at,
    ).not.toBeNull();
    // The offer is answered once.
    expect((await post(inv.id, { outboxId: view.ask?.id })).status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  it("Skip sends nothing and closes the offer", async () => {
    const inv = await asked();
    const view = await overview(inv.id);
    const skipped = await owner.json(`/api/invoices/${inv.id}/courtesy-email/skip`, {
      body: { outboxId: view.ask?.id },
    });
    expect(skipped.status).toBe(204);
    expect(sent).toHaveLength(0);
    expect((await overview(inv.id)).ask).toBeNull();
    expect(
      (await one<{ status: string }>("SELECT status FROM outbox WHERE kind = 'email'")).status,
    ).toBe("skipped");
  });

  it("sends by hand on any issued invoice, again as a resend, and a retried request reuses its key", async () => {
    await configure("off");
    const inv = await sentInvoice();
    const requestId = "request-0001";
    expect((await post(inv.id, { requestId })).status).toBe(201);
    expect((await post(inv.id, { requestId })).status).toBe(201);
    expect((await post(inv.id, {})).status).toBe(201);
    expect(sent).toHaveLength(3);
    expect(sent[0]?.headers["Idempotency-Key"]).toBe("manual-request-0001");
    expect(sent[1]?.headers["Idempotency-Key"]).toBe("manual-request-0001");
    expect(sent[2]?.headers["Idempotency-Key"]).not.toBe("manual-request-0001");
    expect((await overview(inv.id)).log.every((l) => l.trigger === "manual")).toBe(true);
  });

  it("answers 502 email_failed and logs a failed send", async () => {
    await configure("off");
    const inv = await sentInvoice();
    reply = () => Response.json({ name: "invalid_from_address" }, { status: 403 });
    const response = await post(inv.id, {});
    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      code: "email_failed",
      detail: "resend_403_invalid_from_address",
    });
    expect((await overview(inv.id)).log[0]).toMatchObject({
      status: "failed",
      error: "resend_403_invalid_from_address",
    });
  });

  it("names RESEND_API_KEY when it is missing and sends nothing", async () => {
    await configure("off");
    const inv = await sentInvoice();
    const keyless = new TestClient("10.14.0.3", {
      ...bindings,
      RESEND_API_KEY: undefined,
    } as Bindings);
    await signIn(keyless);
    const response = await keyless.json(`/api/invoices/${inv.id}/courtesy-email`, {
      body: { requestId: "request-0002", to: "billing@acme.test", subject: "s", body: "b" },
    });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: "missing_secret",
      missing: ["RESEND_API_KEY"],
      fix: "wrangler secret put RESEND_API_KEY",
    });
    expect(sent).toHaveLength(0);
  });

  it("has no draft for an invoice without a stored PDF and refuses to send", async () => {
    await configure("off");
    const bare = await seedInvoice(env.DB, { attempts: [{ fileName: FILE }] });
    expect((await overview(bare.id)).draft).toBeNull();
    expect((await post(bare.id, {})).status).toBe(409);
  });
});
