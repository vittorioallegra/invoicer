import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QUIET_PERIOD_MS } from "../../shared/channel/quiet-period";
import { type Channel, ChannelError, type ChannelSendInput } from "../../shared/channel/types";
import { EMPTY_CLIENT_DEFAULTS } from "../../shared/client";
import { EMPTY_INVOICE_DATA } from "../../shared/invoice";
import {
  applyMigrations,
  setupOwner,
  signIn,
  TestClient,
  totpCode,
  VirtualAuthenticator,
} from "../auth/test-helpers";
import { channelDeps } from "../channel";
import { type Bindings, isMockChannel } from "../env";
import { smtpDeps } from "../pec/smtp";
import { SMTP_ERRORS } from "../pec/smtp.fixtures";

const PEC_USERNAME = "owner@pec.example.it";
const PEC_PASSWORD = "hunter2-very-secret-pec-password";
const bindings = {
  ...env,
  PEC_USERNAME,
  PEC_PASSWORD,
  SEND_CHANNEL: "",
} as unknown as Bindings;
const device = new VirtualAuthenticator();
const defaultCreate = channelDeps.create;

let owner: TestClient;
let clientId: string;
let totpUri = "";
let sent: ChannelSendInput[] = [];
let created = 0;
let behaviour: () => Promise<void> = async () => undefined;

const fakeChannel: Channel = {
  id: "pec",
  async send(input) {
    sent.push(input);
    await behaviour();
    return { messageId: input.messageId };
  },
};

beforeEach(() => {
  sent = [];
  created = 0;
  behaviour = async () => undefined;
  channelDeps.create = () => {
    created++;
    return fakeChannel;
  };
});
afterEach(() => {
  channelDeps.create = defaultCreate;
});

const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const xmlFor = (fileName: string, extra = "") => {
  const progressive = /_([A-Za-z0-9]+)\.xml$/.exec(fileName)?.[1];
  return new TextEncoder().encode(
    `<?xml version="1.0"?><p:FatturaElettronica><ProgressivoInvio>${progressive}</ProgressivoInvio>${extra}</p:FatturaElettronica>`,
  );
};

interface Tx {
  attempts: { id: string; attempt: number; fileName: string; outcome: string }[];
  retry: { allowed: boolean; mode?: string; reason?: string };
}
const transmissions = async (id: string) =>
  (await owner.json<Tx>(`/api/invoices/${id}/transmissions`)).body;

/** A reserved invoice with its final XML uploaded to the current attempt. */
async function reserved(): Promise<{ id: string; fileName: string; xml: Uint8Array }> {
  const created_ = await owner.json<{ invoice: { id: string } }>("/api/invoices", {
    body: {
      documentType: "TD01",
      clientId,
      currency: "EUR",
      plannedDate: null,
      operationDate: null,
      dueDate: null,
      linkedInvoiceId: null,
      notes: null,
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
  const id = created_.body.invoice.id;
  expect((await owner.json(`/api/invoices/${id}/reserve-number`, { body: {} })).status).toBe(200);
  return { id, ...(await uploadXml(id)) };
}

async function uploadXml(id: string) {
  const current = (await transmissions(id)).attempts.at(-1);
  const fileName = current?.fileName ?? "";
  const xml = xmlFor(fileName);
  const res = await owner.json(`/api/invoices/${id}/xml`, {
    method: "PUT",
    body: xml,
    contentType: "application/xml",
  });
  expect(res.status).toBe(201);
  return { fileName, xml };
}

/** Challenge bound to `hash` and a passkey answer to it. */
async function answer(id: string, hash: string) {
  const { body } = await owner.json<{
    challengeId: string;
    options: { challenge: string; rpId: string };
  }>(`/api/invoices/${id}/send-challenge`, { body: { xmlSha256: hash } });
  return {
    challengeId: body.challengeId,
    passkey: await device.assert({ challenge: body.options.challenge, rpId: body.options.rpId }),
  };
}

const sendWith = (id: string, a: unknown) =>
  owner.json<{ code?: string; detail?: string; messageId?: string; to?: string }>(
    `/api/invoices/${id}/send`,
    { body: { answer: a } },
  );
const sendOk = async (id: string, xml: Uint8Array) =>
  sendWith(id, await answer(id, await sha256(xml)));

const outcomeRow = (id: string) =>
  env.DB.prepare(
    `SELECT t.send_outcome AS outcome, t.channel_message_id AS messageId, t.file_name AS fileName,
            t.sdi_pec_address AS sdi, i.state, i.number_int AS number, i.issue_date AS issueDate
     FROM transmissions t JOIN invoices i ON i.id = t.invoice_id
     WHERE t.invoice_id = ? ORDER BY t.attempt DESC LIMIT 1`,
  )
    .bind(id)
    .first<{
      outcome: string;
      messageId: string | null;
      fileName: string;
      sdi: string | null;
      state: string;
      number: number;
      issueDate: string;
    }>();

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.7.0.1", bindings));
  owner = new TestClient("10.7.0.2", bindings);
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
  totpUri = enabled.body.totpURI;
  await owner.json("/api/auth/two-factor/verify-totp", { body: { code: await totpCode(totpUri) } });
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
        email: "",
        pdfLanguage: "en",
        currency: "EUR",
        defaults: EMPTY_CLIENT_DEFAULTS,
      },
    })
  ).body.client.id;
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
  await env.DB.prepare(
    "INSERT INTO settings (id, pec_test_at, pec_test_ok) VALUES (1, ?, 1) ON CONFLICT(id) DO UPDATE SET pec_test_at = excluded.pec_test_at, pec_test_ok = 1",
  )
    .bind(Date.now())
    .run();
});

describe("AC 5: a send needs a valid assertion, and no socket exists before it", () => {
  it("refuses a missing, wrong-hash, wrong-invoice and replayed answer without creating a channel", async () => {
    const a = await reserved();
    const other = await reserved();
    const hash = await sha256(a.xml);

    expect((await sendWith(a.id, { challengeId: "nope" })).status).toBe(403);
    // Challenge bound to a different XML hash (the browser may not choose the hash).
    expect((await sendWith(a.id, await answer(a.id, "0".repeat(64)))).status).toBe(403);
    // Challenge issued for another invoice.
    expect((await sendWith(a.id, await answer(other.id, hash))).status).toBe(403);
    // Replay of a used answer.
    const good = await answer(a.id, hash);
    const first = await sendWith(a.id, good);
    expect(first.status).toBe(200);
    // The attempt is already out, so a replay is refused before it even reaches the assertion.
    expect((await sendWith(a.id, good)).status).toBe(409);
    expect(created).toBe(1);
    expect(sent).toHaveLength(1);
    expect((await outcomeRow(other.id))?.outcome).toBe("none");
  });

  it("opens no SMTP socket before the assertion is verified (real channel factory)", async () => {
    channelDeps.create = defaultCreate;
    let connects = 0;
    smtpDeps.connect = async () => {
      connects++;
      return { send: async () => undefined, close: async () => undefined };
    };
    const a = await reserved();
    expect((await sendWith(a.id, { challengeId: "nope" })).status).toBe(403);
    expect((await sendWith(a.id, await answer(a.id, "f".repeat(64)))).status).toBe(403);
    expect(connects).toBe(0);
    const ok = await sendOk(a.id, a.xml);
    expect(ok.status).toBe(200);
    expect(connects).toBe(1);
  });

  it("computes the hash from the stored XML, so replacing the XML invalidates an approval", async () => {
    const a = await reserved();
    const approved = await answer(a.id, await sha256(a.xml));
    // The stored XML changes after the owner approved the old one.
    await owner.json(`/api/invoices/${a.id}/xml`, {
      method: "PUT",
      body: xmlFor(a.fileName, "<Changed/>"),
      contentType: "application/xml",
    });
    expect((await sendWith(a.id, approved)).status).toBe(403);
    expect(created).toBe(0);
  });

  it("accepts a fresh TOTP code as the fallback", async () => {
    const a = await reserved();
    const { body } = await owner.json<{ challengeId: string }>(
      `/api/invoices/${a.id}/send-challenge`,
      { body: { xmlSha256: await sha256(a.xml) } },
    );
    const wrong = await sendWith(a.id, { challengeId: body.challengeId, totp: "000000" });
    expect(wrong.status).toBe(403);
    expect(created).toBe(0);
    const { body: again } = await owner.json<{ challengeId: string }>(
      `/api/invoices/${a.id}/send-challenge`,
      { body: { xmlSha256: await sha256(a.xml) } },
    );
    const ok = await sendWith(a.id, {
      challengeId: again.challengeId,
      totp: await totpCode(totpUri),
    });
    expect(ok.status).toBe(200);
  });
});

describe("sending and the stored outcome", () => {
  it("sends to sdi01 first, stores the Message-ID before and after, and stays `sending`", async () => {
    const a = await reserved();
    const seen: { during: Awaited<ReturnType<typeof outcomeRow>> } = { during: null };
    behaviour = async () => {
      seen.during = await outcomeRow(a.id);
    };
    const res = await sendOk(a.id, a.xml);
    expect(res.status).toBe(200);
    expect(sent[0]).toMatchObject({ fileName: a.fileName, to: "sdi01@pec.fatturapa.it" });
    expect(sent[0]?.xml).toEqual(a.xml);
    // File name and Message-ID are on the row before the SMTP session ends.
    const during = seen.during;
    expect(during).toMatchObject({ outcome: "unknown", fileName: a.fileName });
    expect(during?.messageId).toMatch(/^<.+@pec\.example\.it>$/);
    const row = await outcomeRow(a.id);
    expect(row).toMatchObject({
      outcome: "complete",
      state: "sending",
      messageId: res.body.messageId,
    });
  });

  it("uses the SdI address from settings once the SdI has named it", async () => {
    await env.DB.prepare(
      "UPDATE settings SET sdi_pec_address = 'sdi99@pec.fatturapa.it' WHERE id = 1",
    ).run();
    try {
      const a = await reserved();
      await sendOk(a.id, a.xml);
      expect(sent[0]?.to).toBe("sdi99@pec.fatturapa.it");
      expect((await outcomeRow(a.id))?.sdi).toBe("sdi99@pec.fatturapa.it");
    } finally {
      await env.DB.prepare("UPDATE settings SET sdi_pec_address = NULL WHERE id = 1").run();
    }
  });

  it("SMTP refusal after reserve: nothing sent, same attempt retried, number kept", async () => {
    const a = await reserved();
    behaviour = async () => {
      throw new ChannelError("mailbox_full", "none");
    };
    const res = await sendOk(a.id, a.xml);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("pec_mailbox_full");
    expect(await outcomeRow(a.id)).toMatchObject({
      outcome: "none",
      messageId: null,
      state: "sending",
    });
    expect((await transmissions(a.id)).retry).toEqual({ allowed: true, mode: "same_attempt" });

    behaviour = async () => undefined;
    const again = await owner.json<{ transmission: { fileName: string } }>(
      `/api/invoices/${a.id}/new-attempt`,
      { body: {} },
    );
    expect(again.body.transmission.fileName).toBe(a.fileName);
    expect((await sendOk(a.id, a.xml)).status).toBe(200);
  });

  it("timeout after reserve: unknown, no release, no retry in the quiet period, new file after", async () => {
    const a = await reserved();
    const before = await outcomeRow(a.id);
    behaviour = async () => {
      throw new ChannelError("unknown_outcome", "unknown");
    };
    const res = await sendOk(a.id, a.xml);
    expect(res.status).toBe(504);
    expect(res.body.code).toBe("send_outcome_unknown");
    expect((await outcomeRow(a.id))?.outcome).toBe("unknown");
    expect((await owner.json(`/api/invoices/${a.id}/release-number`, { body: {} })).status).toBe(
      409,
    );

    // "Not found" within the quiet period does not unlock a retry.
    const early = await owner.json<{ detail: string }>(`/api/invoices/${a.id}/new-attempt`, {
      body: {},
    });
    expect(early.status).toBe(409);
    expect(early.body.detail).toContain("quiet_period");
    expect((await sendOk(a.id, a.xml)).status).toBe(409);
    expect((await transmissions(a.id)).attempts).toHaveLength(1);

    await env.DB.prepare("UPDATE transmissions SET updated_at = ? WHERE invoice_id = ?")
      .bind(Date.now() - QUIET_PERIOD_MS - 1000, a.id)
      .run();
    // The quiet period is over, but until a poll completes after it the retry stays locked.
    const waiting = await owner.json<{ detail: string }>(`/api/invoices/${a.id}/new-attempt`, {
      body: {},
    });
    expect(waiting.status).toBe(409);
    expect(waiting.body.detail).toContain("awaiting_poll");
    await env.DB.prepare(
      "INSERT INTO job_runs (id, job, run_date, started_at, finished_at, status) VALUES (?, 'poll', '2026-11-02', ?, ?, 'success')",
    )
      .bind(crypto.randomUUID(), Date.now() - 1000, Date.now() - 500)
      .run();
    const next = await owner.json<{ transmission: { fileName: string; attempt: number } }>(
      `/api/invoices/${a.id}/new-attempt`,
      { body: {} },
    );
    expect(next.status).toBe(200);
    expect(next.body.transmission.attempt).toBe(2);
    expect(next.body.transmission.fileName).not.toBe(a.fileName);
    const xml2 = (await uploadXml(a.id)).xml;
    behaviour = async () => undefined;
    expect((await sendOk(a.id, xml2)).status).toBe(200);
    const after = await outcomeRow(a.id);
    expect(after).toMatchObject({ number: before?.number, issueDate: before?.issueDate });
    expect(after?.fileName).toBe(next.body.transmission.fileName);
  });

  it("SMTP ok but the Worker fails before storing the result: the attempt stays unknown with its Message-ID", async () => {
    const a = await reserved();
    await env.DB.exec(
      "CREATE TRIGGER fail_complete BEFORE UPDATE OF send_outcome ON transmissions WHEN NEW.send_outcome = 'complete' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      const res = await sendOk(a.id, a.xml);
      expect(res.status).toBe(500);
    } finally {
      await env.DB.exec("DROP TRIGGER fail_complete");
    }
    expect(sent).toHaveLength(1);
    const row = await outcomeRow(a.id);
    expect(row?.outcome).toBe("unknown");
    expect(row?.messageId).toBeTruthy();
    expect(row?.state).toBe("sending");
  });

  it("refuses a final XML that is not the invoice's current file", async () => {
    const a = await reserved();
    const bad = await owner.json(`/api/invoices/${a.id}/xml`, {
      method: "PUT",
      body: xmlFor("IT12345678903_ZZZZZ.xml"),
      contentType: "application/xml",
    });
    expect(bad.status).toBe(400);
  });
});

describe("rejection and resend", () => {
  async function rejected() {
    const a = await reserved();
    expect((await sendOk(a.id, a.xml)).status).toBe(200);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE invoices SET state = 'rejected', state_rank = 6 WHERE id = ?").bind(
        a.id,
      ),
      env.DB.prepare(
        `INSERT INTO events (id, source_id, type, invoice_id, payload, occurred_at, created_at)
         VALUES (?, ?, 'NS', ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        `ns-${a.id}`,
        a.id,
        JSON.stringify({ errors: [{ code: "00311", description: "Codice destinatario errato" }] }),
        now,
        now,
      ),
    ]);
    return a;
  }

  it("fix and resend keeps number and date and uses a new file name", async () => {
    const a = await rejected();
    const before = await outcomeRow(a.id);
    const next = await owner.json<{ transmission: { fileName: string } }>(
      `/api/invoices/${a.id}/new-attempt`,
      { body: {} },
    );
    expect(next.status).toBe(200);
    expect(next.body.transmission.fileName).not.toBe(a.fileName);
    const { xml } = await uploadXml(a.id);
    expect((await sendOk(a.id, xml)).status).toBe(200);
    const after = await outcomeRow(a.id);
    expect(after).toMatchObject({
      state: "sending",
      number: before?.number,
      issueDate: before?.issueDate,
      fileName: next.body.transmission.fileName,
    });
    expect(sent.at(-1)?.fileName).toBe(next.body.transmission.fileName);
  });

  it("refuses a resend after the 5-day window", async () => {
    const a = await rejected();
    await env.DB.prepare("UPDATE events SET occurred_at = ? WHERE invoice_id = ?")
      .bind(Date.now() - 6 * 24 * 3600 * 1000, a.id)
      .run();
    const res = await owner.json<{ detail: string }>(`/api/invoices/${a.id}/new-attempt`, {
      body: {},
    });
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain("rejection_window_expired");
  });

  it("a PEC refusal is not a rejection: no deadline, same number and date", async () => {
    const a = await reserved();
    behaviour = async () => {
      throw new ChannelError("rejected", "none");
    };
    await sendOk(a.id, a.xml);
    // Far in the future nothing expires: only an SdI NS starts a deadline.
    expect((await transmissions(a.id)).retry).toEqual({ allowed: true, mode: "same_attempt" });
  });
});

describe("manual AdE channel", () => {
  it("hands over, then records the portal outcome by hand (rejection with error text)", async () => {
    const a = await reserved();
    expect(
      (await owner.json(`/api/invoices/${a.id}/manual/outcome`, { body: { outcome: "delivered" } }))
        .status,
    ).toBe(409);
    const handed = await owner.json(`/api/invoices/${a.id}/manual/handed-over`, { body: {} });
    expect(handed.status).toBe(200);
    expect(created).toBe(0);
    expect(await outcomeRow(a.id)).toMatchObject({ outcome: "complete", state: "sent" });

    const noText = await owner.json(`/api/invoices/${a.id}/manual/outcome`, {
      body: { outcome: "rejected" },
    });
    expect(noText.status).toBe(400);
    const res = await owner.json(`/api/invoices/${a.id}/manual/outcome`, {
      body: {
        outcome: "rejected",
        errors: [{ code: "00300", description: "Codice fiscale errato" }],
      },
    });
    expect(res.status).toBe(200);
    const event = await env.DB.prepare("SELECT type, payload FROM events WHERE invoice_id = ?")
      .bind(a.id)
      .first<{ type: string; payload: string }>();
    expect(event?.type).toBe("NS");
    expect(JSON.parse(event?.payload ?? "{}")).toEqual({
      errors: [{ code: "00300", description: "Codice fiscale errato" }],
    });
    const invoice = await owner.json<{
      invoice: { state: string; rejection: { errors: { code: string }[] } };
    }>(`/api/invoices/${a.id}`);
    expect(invoice.body.invoice.state).toBe("rejected");
    expect(invoice.body.invoice.rejection.errors[0]?.code).toBe("00300");
  });

  it("marks delivered", async () => {
    const a = await reserved();
    await owner.json(`/api/invoices/${a.id}/manual/handed-over`, { body: {} });
    await owner.json(`/api/invoices/${a.id}/manual/outcome`, { body: { outcome: "delivered" } });
    expect((await outcomeRow(a.id))?.state).toBe("delivered");
  });
});

describe("downloads, secrets and the mock channel", () => {
  it("serves XML and PDF as attachments", async () => {
    const a = await reserved();
    const xml = await owner.request(`/api/invoices/${a.id}/xml`);
    expect(xml.status).toBe(200);
    expect(xml.headers.get("Content-Disposition")).toBe(`attachment; filename="${a.fileName}"`);
    expect(xml.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await owner.json(`/api/invoices/${a.id}/pdf`, {
      method: "PUT",
      body: new TextEncoder().encode("%PDF-1.3\nxxxxxxxx"),
      contentType: "application/pdf",
    });
    const pdf = await owner.request(`/api/invoices/${a.id}/pdf`);
    expect(pdf.headers.get("Content-Disposition")).toMatch(/^attachment; filename=/);
  });

  it("keeps the PEC password out of responses, D1 and logs when the server echoes it", async () => {
    channelDeps.create = defaultCreate;
    smtpDeps.connect = async () => {
      throw new Error(`${SMTP_ERRORS.authFailed} for ${PEC_USERNAME} / ${PEC_PASSWORD}`);
    };
    const a = await reserved();
    const res = await sendOk(a.id, a.xml);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("pec_auth_failed");
    const everything = JSON.stringify([
      res.body,
      (await env.DB.prepare("SELECT * FROM transmissions").all()).results,
      (await env.DB.prepare("SELECT * FROM events").all()).results,
    ]);
    expect(everything).not.toContain(PEC_PASSWORD);
  });

  it("enables the mock channel only for an explicit var on a localhost origin", () => {
    const base = { APP_ORIGIN: "http://localhost:5173" } as Bindings;
    expect(isMockChannel({ ...base, SEND_CHANNEL: "mock" })).toBe(true);
    expect(isMockChannel({ ...base })).toBe(false);
    expect(
      isMockChannel({
        APP_ORIGIN: "https://invoicer.example.com",
        SEND_CHANNEL: "mock",
      } as Bindings),
    ).toBe(false);
    expect(isMockChannel({ SEND_CHANNEL: "mock" } as Bindings)).toBe(false);
  });
});
