import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../../db/schema";
import { EMPTY_CLIENT_DEFAULTS } from "../../shared/client";
import { EMPTY_INVOICE_DATA } from "../../shared/invoice";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";

const bindings = { ...env, PEC_USERNAME: "user", PEC_PASSWORD: "pass" } as unknown as Bindings;
let owner: TestClient;
let clientId: string;

const pdfBytes = (size = 64, tail = "x") =>
  new TextEncoder().encode(`%PDF-1.3\n${tail.repeat(Math.max(0, size - 9))}`);

type Stored = {
  file: {
    id: string;
    filename: string;
    size: number;
    sha256: string;
    transmissionId: string;
    attempt: number;
  };
};

const put = (id: string, body: Uint8Array) =>
  owner.json<Stored>(`/api/invoices/${id}/pdf`, {
    method: "PUT",
    body,
    contentType: "application/pdf",
  });

async function reservedInvoice(): Promise<string> {
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
  const reserved = await owner.json(`/api/invoices/${id}/reserve-number`, { body: {} });
  expect(reserved.status).toBe(200);
  return id;
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.9.0.1", bindings));
  owner = new TestClient("10.9.0.2", bindings);
  await signIn(owner);
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

describe("invoice PDF storage", () => {
  it("needs a session", async () => {
    const anon = new TestClient("10.9.1.1", bindings);
    expect((await anon.json("/api/invoices/x/pdf")).status).toBe(401);
    const upload = await anon.request("/api/invoices/x/pdf", {
      method: "PUT",
      body: pdfBytes(),
      contentType: "application/pdf",
    });
    expect(upload.status).toBe(401);
  });

  it("stores the PDF on the current transmission attempt and serves it back", async () => {
    const id = await reservedInvoice();
    const bytes = pdfBytes(200, "a");
    const stored = await put(id, bytes);
    expect(stored.status).toBe(201);
    expect(stored.body.file).toMatchObject({ attempt: 1, size: 200 });
    expect(stored.body.file.filename).toMatch(/^IT12345678903_\d{5}\.pdf$/);
    expect(stored.body.file.sha256).toMatch(/^[0-9a-f]{64}$/);

    const row = await env.DB.prepare(
      "SELECT kind, invoice_id, transmission_id, size FROM files WHERE id = ?",
    )
      .bind(stored.body.file.id)
      .first();
    expect(row).toMatchObject({
      kind: "pdf",
      invoice_id: id,
      transmission_id: stored.body.file.transmissionId,
      size: 200,
    });
    const linked = await env.DB.prepare("SELECT pdf_file_id FROM transmissions WHERE id = ?")
      .bind(stored.body.file.transmissionId)
      .first<{ pdf_file_id: string }>();
    expect(linked?.pdf_file_id).toBe(stored.body.file.id);

    const download = await owner.request(`/api/invoices/${id}/pdf`);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe("application/pdf");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
  });

  it("replaces the PDF of the same attempt instead of piling up files", async () => {
    const id = await reservedInvoice();
    const first = await put(id, pdfBytes(100, "a"));
    const second = await put(id, pdfBytes(120, "b"));
    expect(second.body.file.transmissionId).toBe(first.body.file.transmissionId);
    expect(second.body.file.id).not.toBe(first.body.file.id);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE invoice_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    const download = await owner.request(`/api/invoices/${id}/pdf`);
    expect((await download.arrayBuffer()).byteLength).toBe(120);
  });

  it("keeps one PDF per attempt on a resend and serves the latest", async () => {
    const id = await reservedInvoice();
    const first = await put(id, pdfBytes(100, "a"));
    // The first attempt was handed to the PEC and got rejected; a resend opens attempt 2.
    await env.DB.batch([
      env.DB.prepare("UPDATE transmissions SET send_outcome = 'complete' WHERE id = ?").bind(
        first.body.file.transmissionId,
      ),
      env.DB.prepare("UPDATE invoices SET state = 'rejected', state_rank = 6 WHERE id = ?").bind(
        id,
      ),
    ]);
    const { addTransmissionAttempt } = await import("../invoices/numbering");
    await addTransmissionAttempt(env.DB, {
      invoiceId: id,
      now: new Date(),
      idPaese: "IT",
      idCodice: "12345678903",
    });

    // The sent attempt is final, the new one takes the new PDF.
    const second = await put(id, pdfBytes(150, "b"));
    expect(second.status).toBe(201);
    expect(second.body.file.attempt).toBe(2);
    expect(second.body.file.transmissionId).not.toBe(first.body.file.transmissionId);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE invoice_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
    const download = await owner.request(`/api/invoices/${id}/pdf`);
    expect((await download.arrayBuffer()).byteLength).toBe(150);
  });

  it("refuses to change the PDF of an attempt already handed to the PEC", async () => {
    const id = await reservedInvoice();
    const stored = await put(id, pdfBytes());
    await env.DB.prepare("UPDATE transmissions SET send_outcome = 'complete' WHERE id = ?")
      .bind(stored.body.file.transmissionId)
      .run();
    const refused = await owner.json<{ detail: string }>(`/api/invoices/${id}/pdf`, {
      method: "PUT",
      body: pdfBytes(),
      contentType: "application/pdf",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toBe("transmission_sent");
  });

  it("refuses files over the size limit and bodies that are not PDFs", async () => {
    const id = await reservedInvoice();
    const big = await put(id, pdfBytes(MAX_FILE_BYTES + 1));
    expect(big.status).toBe(413);
    const text = await owner.json<{ detail: string }>(`/api/invoices/${id}/pdf`, {
      method: "PUT",
      body: new TextEncoder().encode("hello"),
      contentType: "application/pdf",
    });
    expect(text.status).toBe(400);
    expect((await owner.json(`/api/invoices/${id}/pdf`)).status).toBe(404);
  });

  it("answers 404 for a missing invoice and 409 for one without a number", async () => {
    expect((await put("missing", pdfBytes())).status).toBe(404);
    const draft = await owner.json<{ invoice: { id: string } }>("/api/invoices", {
      body: {
        documentType: "TD01",
        clientId,
        currency: "EUR",
        invoiceDate: null,
        dueDate: null,
        linkedInvoiceId: null,
        lines: [],
        data: EMPTY_INVOICE_DATA,
      },
    });
    const refused = await put(draft.body.invoice.id, pdfBytes());
    expect(refused.status).toBe(409);
    expect((await owner.json(`/api/invoices/${draft.body.invoice.id}/pdf`)).status).toBe(404);
  });
});
