import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  encodeImportMeta,
  IMPORT_META_HEADER,
  type ImportFileOutcome,
  type IssuedImportMeta,
} from "../../shared/import";
import type { InvoiceRecord } from "../../shared/invoice";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";

const bindings = env as unknown as Bindings;
let owner: TestClient;

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.12.0.1", bindings));
  owner = new TestClient("10.12.0.2", bindings);
  await signIn(owner);
});

const bytes = (text: string) => new TextEncoder().encode(text);

const meta = (over: Partial<IssuedImportMeta> = {}): IssuedImportMeta => ({
  fileName: "IT01234567890_00001.xml",
  documentType: "TD01",
  number: "1",
  date: "2024-03-10",
  dueDate: "2024-04-10",
  currency: "EUR",
  totalCents: 12200,
  paid: true,
  customer: { name: "Acme", vatCountry: "IT", vatCode: "12345678903", taxCode: null, client: null },
  ...over,
});

const post = (content: string, m: IssuedImportMeta) =>
  owner.json<ImportFileOutcome>("/api/invoices/import", {
    method: "POST",
    body: bytes(content),
    contentType: "application/octet-stream",
    headers: { [IMPORT_META_HEADER]: encodeImportMeta(m) },
  });

const nextNumber = async (year: number, series?: string) =>
  (
    await owner.json<{ next: number }>(
      `/api/invoices/next-number?year=${year}${series ? `&series=${series}` : ""}`,
    )
  ).body.next;

describe("POST /api/invoices/import", () => {
  it("needs a session", async () => {
    const anon = new TestClient("10.12.0.3", bindings);
    const res = await anon.json("/api/invoices/import", { method: "POST", body: bytes("x") });
    expect(res.status).toBe(401);
  });

  it("stores a delivered, read-only invoice whose number blocks reuse (AC 17)", async () => {
    const res = await post("<one/>", meta({ number: "7" }));
    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe("imported");
    const id = (res.body as { id: string }).id;

    const record = (await owner.json<{ invoice: InvoiceRecord }>(`/api/invoices/${id}`)).body
      .invoice;
    expect(record).toMatchObject({
      source: "imported",
      state: "delivered",
      number: "7",
      year: 2024,
      issueDate: "2024-03-10",
      dueDate: "2024-04-10",
      totalCents: 12200,
      paymentFlag: "paid",
      seriesId: "default",
    });

    // The imported number counts like any issued number.
    expect(await nextNumber(2024)).toBe(8);
    expect(await nextNumber(2025)).toBe(1);

    // Read-only: no edit, delete, duplicate or credit note.
    expect((await owner.json(`/api/invoices/${id}`, { method: "PUT", body: {} })).status).toBe(400);
    expect((await owner.json(`/api/invoices/${id}`, { method: "DELETE" })).status).toBe(409);
    expect((await owner.json(`/api/invoices/${id}/duplicate`, { body: {} })).status).toBe(409);
    expect((await owner.json(`/api/invoices/${id}/credit-note`, { body: {} })).status).toBe(409);

    const original = await owner.request(`/api/invoices/${id}/original`);
    expect(original.status).toBe(200);
    expect(await original.text()).toBe("<one/>");
  });

  it("reports the same file and the same invoice as duplicates, a taken number as a conflict", async () => {
    const first = await post("<a/>", meta({ number: "21", fileName: "a.xml" }));
    const firstId = (first.body as { id: string }).id;
    expect((await post("<a/>", meta({ number: "21" }))).body).toEqual({
      outcome: "duplicate",
      id: firstId,
    });
    expect((await post("<b/>", meta({ number: "21", fileName: "b.xml" }))).body).toEqual({
      outcome: "duplicate",
      id: firstId,
    });
    const other = await post("<c/>", meta({ number: "21", totalCents: 999, fileName: "c.xml" }));
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ outcome: "number_conflict", id: firstId, number: "21" });
    // The same number in another year is free.
    const next = await post("<d/>", meta({ number: "21", date: "2023-05-01", fileName: "d.xml" }));
    expect(next.body.outcome).toBe("imported");
  });

  it("puts a number into the series whose prefix it carries, and stores free text without a progressive", async () => {
    const series = await owner.json<{ series: { id: string } }>("/api/numbering-series", {
      body: { name: "Swiss", prefix: "CH-" },
    });
    const ch = series.body.series.id;
    const res = await post(
      "<ch/>",
      meta({ number: "CH-4", fileName: "ch.xml", date: "2022-02-02" }),
    );
    expect(res.body.outcome).toBe("imported");
    expect(await nextNumber(2022, ch)).toBe(5);
    expect(await nextNumber(2022)).toBe(1);

    const text = await post(
      "<t/>",
      meta({ number: "2022/A", fileName: "t.xml", date: "2022-02-03" }),
    );
    expect(text.body.outcome).toBe("imported");
    const row = await env.DB.prepare(
      "SELECT number_int AS n, year FROM invoices WHERE number_raw = '2022/A'",
    ).first<{ n: number | null; year: number }>();
    expect(row).toEqual({ n: null, year: 2022 });
    expect(await nextNumber(2022)).toBe(1);
  });

  it("links an existing client by VAT number and creates one from a valid customer", async () => {
    const client = {
      type: "it_company",
      name: "Beta Srl",
      vatNumber: "01234567897",
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
      pdfLanguage: "it",
      currency: "EUR",
      defaults: {},
    };
    const created = await post(
      "<beta/>",
      meta({
        number: "31",
        fileName: "beta.xml",
        customer: {
          name: "Beta Srl",
          vatCountry: "IT",
          vatCode: "01234567897",
          taxCode: null,
          client,
        },
      }),
    );
    expect(created.body).toMatchObject({ outcome: "imported", clientLinked: true });
    const row = await env.DB.prepare(
      "SELECT c.name, c.vat_number AS vat FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.number_raw = '31'",
    ).first<{ name: string; vat: string }>();
    expect(row).toEqual({ name: "Beta Srl", vat: "01234567897" });

    // The next invoice for the same VAT number reuses that client, whatever the file says.
    const second = await post(
      "<beta2/>",
      meta({
        number: "32",
        fileName: "beta2.xml",
        customer: {
          name: "BETA S.R.L.",
          vatCountry: "IT",
          vatCode: "01234567897",
          taxCode: null,
          client: null,
        },
      }),
    );
    expect(second.body).toMatchObject({ outcome: "imported", clientLinked: true });
    const clients = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM clients WHERE vat_number = '01234567897'",
    ).first<{ n: number }>();
    expect(clients?.n).toBe(1);

    // A customer that fails the client rules is imported without a client.
    const unlinked = await post(
      "<x/>",
      meta({
        number: "33",
        fileName: "x.xml",
        customer: {
          name: "Nobody",
          vatCountry: null,
          vatCode: null,
          taxCode: null,
          client: { name: "x" },
        },
      }),
    );
    expect(unlinked.body).toMatchObject({ outcome: "imported", clientLinked: false });
  });

  it("refuses an empty body and a summary that is not valid", async () => {
    const empty = await owner.json("/api/invoices/import", {
      method: "POST",
      body: new Uint8Array(),
      contentType: "application/octet-stream",
      headers: { [IMPORT_META_HEADER]: encodeImportMeta(meta()) },
    });
    expect(empty.status).toBe(400);
    expect((await post("<a/>", meta({ date: "10/03/2024" }))).status).toBe(400);
    expect((await post("<a/>", meta({ documentType: "TD02" as "TD01" }))).status).toBe(400);
  });
});
