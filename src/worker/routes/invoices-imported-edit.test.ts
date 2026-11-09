import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  encodeImportMeta,
  IMPORT_META_HEADER,
  type ImportFileOutcome,
  type IssuedImportMeta,
} from "../../shared/import";
import { EMPTY_INVOICE_DATA, type InvoiceRecord } from "../../shared/invoice";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";

const bindings = env as unknown as Bindings;
let owner: TestClient;
let clientId: string;

const clientBody = {
  type: "it_company",
  name: "Edit Srl",
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

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.14.0.1", bindings));
  owner = new TestClient("10.14.0.2", bindings);
  await signIn(owner);
  clientId = (await owner.json<{ client: { id: string } }>("/api/clients", { body: clientBody }))
    .body.client.id;
});

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

let counter = 0;
async function importXml(over: Partial<IssuedImportMeta> = {}): Promise<string> {
  counter += 1;
  const res = await owner.json<ImportFileOutcome>("/api/invoices/import", {
    method: "POST",
    body: new TextEncoder().encode(`<invoice n="${counter}"/>`),
    contentType: "application/octet-stream",
    headers: {
      [IMPORT_META_HEADER]: encodeImportMeta(meta({ fileName: `f${counter}.xml`, ...over })),
    },
  });
  return (res.body as { id: string }).id;
}

const line = (over: Record<string, unknown> = {}) => ({
  description: "Consulting",
  note: "",
  quantityMilli: 2000,
  unit: null,
  unitPriceCents: 10000,
  vatRateBp: 2200,
  natura: null,
  ...over,
});

const editBody = (over: Record<string, unknown> = {}) => ({
  documentType: "TD01",
  clientId,
  currency: "EUR",
  invoiceDate: "2024-03-10",
  dueDate: null,
  linkedInvoiceId: null,
  lines: [line()],
  data: EMPTY_INVOICE_DATA,
  number: "1",
  ...over,
});

const put = (id: string, body: unknown) =>
  owner.json<{ invoice: InvoiceRecord; detail?: string }>(`/api/invoices/${id}`, {
    method: "PUT",
    body,
  });

const frozen = (id: string) =>
  env.DB.prepare(
    "SELECT state, state_rank, source, payment_flag, paid_date FROM invoices WHERE id = ?",
  )
    .bind(id)
    .first();

describe("PUT /api/invoices/:id on an imported invoice", () => {
  it("needs a session", async () => {
    const anon = new TestClient("10.14.0.3", bindings);
    expect((await anon.json("/api/invoices/x", { method: "PUT", body: editBody() })).status).toBe(
      401,
    );
  });

  it("stores lines, client, date, number and recomputed totals, and leaves the issued state alone", async () => {
    const id = await importXml({ number: "5" });
    const before = await frozen(id);
    const files = await env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE invoice_id = ?")
      .bind(id)
      .first<{ n: number }>();

    const res = await put(
      id,
      editBody({
        invoiceDate: "2025-01-15",
        number: "9",
        dueDate: "2025-02-15",
        editorForm: { invoiceNote: "typed" },
        data: { ...EMPTY_INVOICE_DATA, note: "A note" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.invoice).toMatchObject({
      source: "imported",
      state: "delivered",
      clientId,
      number: "9",
      year: 2025,
      issueDate: "2025-01-15",
      invoiceDate: "2025-01-15",
      dueDate: "2025-02-15",
      totalCents: 24400,
      paymentFlag: "paid",
      hasOriginal: true,
      editorForm: { invoiceNote: "typed" },
    });
    expect(res.body.invoice.lines).toHaveLength(1);
    expect(res.body.invoice.data.note).toBe("A note");
    expect(await frozen(id)).toEqual(before);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE invoice_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(after).toEqual(files);
    const transmissions = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM transmissions WHERE invoice_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(transmissions?.n).toBe(0);
    // The original is still served.
    expect((await owner.request(`/api/invoices/${id}/original`)).status).toBe(200);
  });

  it("keeps the figures of the file when the lines cannot be totalled, and the stored due date without terms", async () => {
    const id = await importXml({ number: "6", dueDate: "2024-05-01", totalCents: 5555 });
    const res = await put(id, editBody({ number: "6", lines: [line({ vatRateBp: null })] }));
    expect(res.body.invoice.totalCents).toBe(5555);
    expect(res.body.invoice.dueDate).toBe("2024-05-01");
  });

  it("edits an import with no original file the same way, and can change the document type", async () => {
    // Older imports have no stored original: drop it from a fresh one.
    const id = await importXml({ number: "77", date: "2023-06-01", dueDate: null, paid: false });
    await env.DB.prepare("DELETE FROM files WHERE invoice_id = ?").bind(id).run();
    const edited = await put(
      id,
      editBody({ number: "77", invoiceDate: "2023-06-01", documentType: "TD04", lines: [line()] }),
    );
    expect(edited.status).toBe(200);
    expect(edited.body.invoice).toMatchObject({
      hasOriginal: false,
      documentType: "TD04",
      clientId,
      totalCents: 24400,
      state: "delivered",
      paymentFlag: "unpaid",
    });
  });

  it("moves a number: the old one is freed, a taken one is refused with number_unavailable", async () => {
    const a = await importXml({ number: "21", date: "2022-02-01" });
    const b = await importXml({ number: "22", date: "2022-02-02" });
    const refused = await put(b, editBody({ number: "21", invoiceDate: "2022-02-02" }));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "number_unavailable" });
    // Nothing changed on the refused one.
    expect(
      (await owner.json<{ invoice: InvoiceRecord }>(`/api/invoices/${b}`)).body.invoice.number,
    ).toBe("22");
    // Free the number, then take it.
    expect((await put(a, editBody({ number: "30", invoiceDate: "2022-02-01" }))).status).toBe(200);
    expect((await put(b, editBody({ number: "21", invoiceDate: "2022-02-02" }))).status).toBe(200);
    // The new number blocks reuse like any issued number.
    const next = await owner.json<{ next: number }>("/api/invoices/next-number?year=2022");
    expect(next.body.next).toBe(31);
    // Moving the date to another year moves the number with it.
    expect((await put(b, editBody({ number: "21", invoiceDate: "2023-02-02" }))).status).toBe(200);
    const year = await env.DB.prepare("SELECT year FROM invoices WHERE id = ?")
      .bind(b)
      .first<{ year: number }>();
    expect(year?.year).toBe(2023);
  });

  it("matches a series by the number's prefix, honours a chosen series, and allows free text", async () => {
    const series = await owner.json<{ series: { id: string } }>("/api/numbering-series", {
      body: { name: "Swiss edit", prefix: "SW-" },
    });
    const sw = series.body.series.id;
    const id = await importXml({ number: "41", date: "2021-01-05" });
    const matched = await put(id, editBody({ number: "SW-3", invoiceDate: "2021-01-05" }));
    expect(matched.body.invoice).toMatchObject({ number: "SW-3", seriesId: sw });
    const free = await put(
      id,
      editBody({ number: "2021/A", invoiceDate: "2021-01-05", seriesId: sw }),
    );
    expect(free.body.invoice).toMatchObject({ number: "2021/A", seriesId: sw });
    const row = await env.DB.prepare("SELECT number_int AS n FROM invoices WHERE id = ?")
      .bind(id)
      .first<{ n: number | null }>();
    expect(row?.n).toBeNull();
    const bad = await put(id, editBody({ number: "x".repeat(21) }));
    expect(bad.status).toBe(400);
  });

  it("keeps number 1 of a suffix series (1/CH) apart from number 1 of the main series in the same year", async () => {
    const swiss = await owner.json<{ series: { id: string } }>("/api/numbering-series", {
      body: { name: "Swiss plain", suffix: "/XX" },
    });
    const xx = swiss.body.series.id;
    // Main series number 1 of 2022 already exists; a second invoice is 1/XX of the same year.
    await importXml({ number: "1", date: "2022-02-28", totalCents: 111 });
    const id = await importXml({ number: "1/XX", date: "2022-03-31", totalCents: 222 });
    const saved = await put(
      id,
      editBody({ number: "1/XX", invoiceDate: "2022-03-31", seriesId: xx }),
    );
    expect(saved.status).toBe(200);
    expect(saved.body.invoice).toMatchObject({ number: "1/XX", seriesId: xx, year: 2022 });
    // The year is the invoice's, not the current one: moving it to 2023 frees 2022 and takes 2023.
    const moved = await put(
      id,
      editBody({ number: "1/XX", invoiceDate: "2023-01-10", seriesId: xx }),
    );
    expect(moved.body.invoice).toMatchObject({ number: "1/XX", year: 2023 });
  });

  it("is never sent, numbered, released, reissued, duplicated, credited or deleted", async () => {
    const id = await importXml({ number: "51", date: "2020-04-04" });
    await put(id, editBody({ number: "51", invoiceDate: "2020-04-04" }));
    const post = (path: string) => owner.json(`/api/invoices/${id}${path}`, { body: {} });
    for (const path of [
      "/reserve-number",
      "/release-number",
      "/reissue",
      "/duplicate",
      "/credit-note",
    ]) {
      expect((await post(path)).status, path).toBe(409);
    }
    expect((await owner.json(`/api/invoices/${id}`, { method: "DELETE" })).status).toBe(409);
    for (const path of ["/new-attempt", "/send", "/manual/handed-over", "/manual/outcome"]) {
      expect((await owner.json(`/api/invoices/${id}${path}`, { body: {} })).status, path).not.toBe(
        200,
      );
    }
    const xml = await owner.json(`/api/invoices/${id}/xml`, { method: "PUT", body: "<x/>" });
    expect(xml.status).toBe(409);
    const reserve = await post("/reserve-number");
    expect(reserve.body).toMatchObject({ detail: "imported_invoice_never_sent" });
    const row = await frozen(id);
    expect(row).toMatchObject({ state: "delivered", source: "imported" });
  });

  it("still takes the paid flag", async () => {
    const id = await importXml({ number: "61", date: "2020-05-05", paid: false });
    const res = await owner.json<{ invoice: InvoiceRecord }>(`/api/invoices/${id}`, {
      method: "PATCH",
      body: { paymentFlag: "paid" },
    });
    expect(res.body.invoice.paymentFlag).toBe("paid");
  });
});
