import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type {
  IssuedSummaryDraftRow,
  IssuedSummaryRow,
  ReceivedSummaryRow,
  SummaryImportResponse,
} from "../../shared/import";
import type { InvoiceRecord, InvoiceSummary } from "../../shared/invoice";
import type { ReceivedInvoiceRecord } from "../../shared/received";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";
import { pollMailbox } from "../pec/poll";
import { plainMail, receivedInvoiceMessage } from "../pec/receipt-fixtures";
import { useMailbox as openMailbox, pollEnv, resetPolling } from "../pec/test-support";

const bindings = env as unknown as Bindings;
let owner: TestClient;

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.13.0.1", bindings));
  owner = new TestClient("10.13.0.2", bindings);
  await signIn(owner);
});

const issued = (over: Partial<IssuedSummaryRow> = {}): IssuedSummaryRow => ({
  documentType: "TD01",
  number: "1",
  date: "2024-03-10",
  currency: "EUR",
  totalCents: 12200,
  paid: true,
  customer: { name: "Acme S.r.l.", vatCountry: "IT", vatCode: "12345678903", taxCode: null },
  ...over,
});
const received = (over: Partial<ReceivedSummaryRow> = {}): ReceivedSummaryRow => ({
  supplierName: "Tool Shop",
  supplierVat: "98765432109",
  number: "7",
  issueDate: "2024-01-05",
  documentType: "TD01",
  currency: "EUR",
  totalCents: 12200,
  paid: true,
  ...over,
});

const postIssued = (rows: IssuedSummaryRow[]) =>
  owner.json<SummaryImportResponse>("/api/invoices/import-summary", { body: { rows } });
const postReceived = (rows: ReceivedSummaryRow[]) =>
  owner.json<SummaryImportResponse>("/api/received/import-summary", { body: { rows } });
const outcomes = (res: { body: SummaryImportResponse }) => res.body.results.map((r) => r.outcome);

describe("POST /api/invoices/import-summary", () => {
  it("needs a session and a valid body", async () => {
    const anon = new TestClient("10.13.0.3", bindings);
    expect((await anon.json("/api/invoices/import-summary", { body: { rows: [] } })).status).toBe(
      401,
    );
    expect((await postIssued([])).status).toBe(400);
    expect((await postIssued(Array.from({ length: 26 }, () => issued()))).status).toBe(400);
    expect((await postIssued([issued({ date: "10/03/2024" })])).status).toBe(400);
  });

  it("stores delivered read-only invoices with no file, paid on the invoice date", async () => {
    const res = await postIssued([
      issued(),
      issued({ number: "2", date: "2024-04-01", paid: false, totalCents: 500 }),
    ]);
    expect(res.status).toBe(200);
    expect(outcomes(res)).toEqual(["imported", "imported"]);
    const [first, second] = res.body.results;
    const one = await owner.json<{ invoice: InvoiceRecord }>(
      `/api/invoices/${(first as { id: string }).id}`,
    );
    expect(one.body.invoice).toMatchObject({
      source: "imported",
      state: "delivered",
      number: "1",
      year: 2024,
      issueDate: "2024-03-10",
      totalCents: 12200,
      paymentFlag: "paid",
      paidDate: "2024-03-10",
      clientId: null,
      clientName: "Acme S.r.l.",
      hasOriginal: false,
    });
    const two = await owner.json<{ invoice: InvoiceRecord }>(
      `/api/invoices/${(second as { id: string }).id}`,
    );
    expect(two.body.invoice.paymentFlag).toBe("unpaid");
    const files = await env.DB.prepare("SELECT count(*) AS n FROM files").first<{ n: number }>();
    expect(files?.n).toBe(0);
    expect(
      (await owner.request(`/api/invoices/${(first as { id: string }).id}/original`)).status,
    ).toBe(404);
  });

  it("shows the customer name in the list and refuses to change the invoice", async () => {
    const list = await owner.json<{ invoices: InvoiceSummary[] }>(
      "/api/invoices?scope=all&year=all",
    );
    expect(list.body.invoices.map((i) => i.clientName)).toContain("Acme S.r.l.");
    const id = list.body.invoices.find((i) => i.number === "1")?.id ?? "";
    expect((await owner.request(`/api/invoices/${id}`, { method: "DELETE" })).status).toBe(409);
  });

  it("reports a second run as duplicates and a taken number as a conflict", async () => {
    const again = await postIssued([
      issued(),
      issued({ number: "2", date: "2024-04-01", paid: false, totalCents: 500 }),
      issued({ number: "1", totalCents: 999 }),
    ]);
    expect(outcomes(again)).toEqual(["duplicate", "duplicate", "number_conflict"]);
    // The same invoice twice in one request imports once.
    const twice = await postIssued([issued({ number: "50" }), issued({ number: "50" })]);
    expect(outcomes(twice)).toEqual(["imported", "duplicate"]);
    const clash = await postIssued([
      issued({ number: "60" }),
      issued({ number: "60", totalCents: 1 }),
    ]);
    expect(outcomes(clash)).toEqual(["imported", "number_conflict"]);
  });

  it("keeps a number per year, and a number blocks reuse through the progressive", async () => {
    const res = await postIssued([issued({ number: "1", date: "2025-02-01" })]);
    expect(outcomes(res)).toEqual(["imported"]);
    const next = await owner.json<{ next: number }>("/api/invoices/next-number?year=2024");
    expect(next.body.next).toBeGreaterThan(60);
  });

  it("puts a number into the series with its suffix, and free text takes no progressive", async () => {
    const series = await owner.json<{ series: { id: string } }>("/api/numbering-series", {
      body: { name: "CH", suffix: "/CH" },
    });
    const res = await postIssued([
      issued({ number: "3/CH" }),
      issued({ number: "3/CH", totalCents: 5 }),
      issued({ number: "3 bis" }),
      issued({ number: "3 bis" }),
    ]);
    expect(outcomes(res)).toEqual(["imported", "number_conflict", "imported", "duplicate"]);
    const row = await env.DB.prepare(
      "SELECT series_id, number_int FROM invoices WHERE number_raw = '3/CH'",
    ).first<{ series_id: string; number_int: number }>();
    expect(row).toEqual({ series_id: series.body.series.id, number_int: 3 });
    const free = await env.DB.prepare(
      "SELECT number_int FROM invoices WHERE number_raw = '3 bis'",
    ).first<{ number_int: number | null }>();
    expect(free?.number_int).toBeNull();
  });

  it("links an existing client by VAT number or tax code, and creates none", async () => {
    const before = await env.DB.prepare("SELECT count(*) AS n FROM clients").first<{ n: number }>();
    const client = await owner.json<{ client: { id: string } }>("/api/clients", {
      body: {
        type: "it_company",
        name: "Linked Client Ltd",
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
      },
    });
    const res = await postIssued([
      issued({
        number: "70",
        customer: { name: "Name in file", vatCountry: "IT", vatCode: "01234567897", taxCode: null },
      }),
      issued({
        number: "71",
        customer: { name: "Unknown", vatCountry: null, vatCode: null, taxCode: null },
      }),
    ]);
    expect(res.body.results).toMatchObject([
      { outcome: "imported", clientLinked: true },
      { outcome: "imported", clientLinked: false },
    ]);
    const [linked, unlinked] = res.body.results as { id: string }[];
    const one = await owner.json<{ invoice: InvoiceRecord }>(`/api/invoices/${linked?.id}`);
    expect(one.body.invoice).toMatchObject({
      clientId: client.body.client.id,
      clientName: "Linked Client Ltd",
    });
    const other = await owner.json<{ invoice: InvoiceRecord }>(`/api/invoices/${unlinked?.id}`);
    expect(other.body.invoice).toMatchObject({ clientId: null, clientName: "Unknown" });
    const after = await env.DB.prepare("SELECT count(*) AS n FROM clients").first<{ n: number }>();
    expect(after?.n).toBe((before?.n ?? 0) + 1);
  });

  it("stores a credit note", async () => {
    const res = await postIssued([issued({ number: "80", documentType: "TD04", totalCents: 100 })]);
    expect(outcomes(res)).toEqual(["imported"]);
  });
});

const draft = (over: Partial<IssuedSummaryDraftRow> = {}): IssuedSummaryDraftRow => ({
  documentType: "TD01",
  number: "5",
  date: "2099-06-01",
  currency: "EUR",
  totalCents: 0,
  customer: { name: "Later Client", vatCountry: null, vatCode: null, taxCode: null },
  amounts: {
    taxableCents: 100000,
    taxCents: 22000,
    withholdingCents: 0,
    rivalsaCents: 0,
    cassaCents: 0,
    otherCassaCents: 0,
  },
  ...over,
});
const postDrafts = (rows: IssuedSummaryDraftRow[]) =>
  owner.json<SummaryImportResponse>("/api/invoices/import-summary-drafts", { body: { rows } });
const invoiceOf = async (result: unknown) =>
  (await owner.json<{ invoice: InvoiceRecord }>(`/api/invoices/${(result as { id: string }).id}`))
    .body.invoice;

describe("POST /api/invoices/import-summary-drafts", () => {
  it("needs a session and a valid body", async () => {
    const anon = new TestClient("10.13.0.4", bindings);
    expect(
      (await anon.json("/api/invoices/import-summary-drafts", { body: { rows: [] } })).status,
    ).toBe(401);
    expect((await postDrafts([])).status).toBe(400);
    expect((await postDrafts(Array.from({ length: 11 }, () => draft()))).status).toBe(400);
    expect((await postDrafts([draft({ date: "01/06/2099" })])).status).toBe(400);
  });

  it("creates an unsent invoice with the requested number and one line", async () => {
    const res = await postDrafts([draft()]);
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([{ outcome: "imported", clientLinked: false }]);
    const invoice = await invoiceOf(res.body.results[0]);
    expect(invoice).toMatchObject({
      source: "app",
      state: "planned",
      paymentFlag: "unpaid",
      documentType: "TD01",
      currency: "EUR",
      invoiceDate: "2099-06-01",
      number: null,
      requestedNumber: 5,
      clientId: null,
      clientName: "Later Client",
      hasOriginal: false,
    });
    expect(invoice.lines).toEqual([
      expect.objectContaining({
        description: "",
        quantityMilli: 1000,
        unitPriceCents: 100000,
        vatRateBp: 2200,
        natura: null,
      }),
    ]);
    expect(invoice.data.cassa).toBeNull();
    expect(invoice.data.ritenuta).toBeNull();
    const list = await owner.json<{ invoices: InvoiceSummary[] }>("/api/invoices?scope=to_issue");
    expect(list.body.invoices.map((i) => i.id)).toContain(invoice.id);
  });

  it("is a duplicate the second time, and the same row twice imports once", async () => {
    const again = await postDrafts([draft()]);
    expect(outcomes(again)).toEqual(["duplicate"]);
    const twice = await postDrafts([draft({ number: "6" }), draft({ number: "6" })]);
    expect(outcomes(twice)).toEqual(["imported", "duplicate"]);
    const clash = await postDrafts([
      draft({ number: "7" }),
      draft({ number: "7", date: "2099-07-01" }),
    ]);
    expect(outcomes(clash)).toEqual(["imported", "number_conflict"]);
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM invoices WHERE planned_date LIKE '2099-%' AND source = 'app'",
    ).first<{ n: number }>();
    expect(count?.n).toBe(3);
  });

  it("uses the owner's cassa and ritenuta when the row has them, and leaves VAT unset at 0", async () => {
    await owner.json("/api/tax", {
      method: "PUT",
      body: {
        regimeFiscale: "RF19",
        cassa: { type: "TC22", rateBp: 400, mode: "included", subjectToRitenuta: true },
        ritenuta: { type: "RT01", rateBp: 2000, baseBp: 10000, causale: "A" },
      },
    });
    const res = await postDrafts([
      draft({
        number: "10",
        amounts: {
          taxableCents: 100000,
          taxCents: 22880,
          withholdingCents: 20800,
          rivalsaCents: 0,
          cassaCents: 4000,
          otherCassaCents: 0,
        },
      }),
      draft({
        number: "11",
        amounts: { ...draft().amounts, taxCents: 0 },
      }),
    ]);
    expect(outcomes(res)).toEqual(["imported", "imported"]);
    const [first, second] = [
      await invoiceOf(res.body.results[0]),
      await invoiceOf(res.body.results[1]),
    ];
    // IVA / (taxable + cassa) = 22%, the cassa keeps the owner's options but is added on top.
    expect(first.lines[0]).toMatchObject({ unitPriceCents: 100000, vatRateBp: 2200 });
    expect(first.data.cassa).toEqual({
      type: "TC22",
      rateBp: 400,
      mode: "excluded",
      subjectToRitenuta: true,
    });
    expect(first.data.ritenuta).toMatchObject({ type: "RT01", rateBp: 2000 });
    expect(second.lines[0]).toMatchObject({ vatRateBp: null, natura: null });
    expect(second.data.cassa).toBeNull();
    expect(second.data.ritenuta).toBeNull();
  });

  it("creates the invoice without a number that is taken or not above the issued ones", async () => {
    await postIssued([issued({ number: "20", date: "2099-01-01" })]);
    const res = await postDrafts([
      draft({ number: "20" }),
      draft({ number: "19", date: "2099-08-01" }),
      draft({ number: "21", date: "2099-08-02" }),
      draft({ number: "21 bis", date: "2099-08-03" }),
    ]);
    expect(res.body.results).toMatchObject([
      { outcome: "number_conflict", number: "20" },
      { outcome: "imported", numberNote: "unavailable" },
      { outcome: "imported" },
      { outcome: "imported", numberNote: "free_text" },
    ]);
    expect((await invoiceOf(res.body.results[1])).requestedNumber).toBeNull();
    expect((await invoiceOf(res.body.results[2])).requestedNumber).toBe(21);
    expect((await invoiceOf(res.body.results[3])).requestedNumber).toBeNull();
    // Re-importing the number-less ones does not create them twice.
    const again = await postDrafts([draft({ number: "21 bis", date: "2099-08-03" })]);
    expect(outcomes(again)).toEqual(["duplicate"]);
  });

  it("puts the number into its series and links an existing client by VAT number", async () => {
    const series = await owner.json<{ series: { id: string } }>("/api/numbering-series", {
      body: { name: "DR", suffix: "/DR" },
    });
    const clientRow = await env.DB.prepare(
      "SELECT id FROM clients WHERE vat_number = '01234567897'",
    ).first<{ id: string }>();
    const res = await postDrafts([
      draft({
        number: "3/DR",
        customer: { name: "Name in file", vatCountry: "IT", vatCode: "01234567897", taxCode: null },
      }),
    ]);
    expect(res.body.results).toMatchObject([{ outcome: "imported", clientLinked: true }]);
    const invoice = await invoiceOf(res.body.results[0]);
    expect(invoice).toMatchObject({
      seriesId: series.body.series.id,
      requestedNumber: 3,
      clientId: clientRow?.id,
    });
  });
});

describe("POST /api/received/import-summary", () => {
  it("stores parsed received invoices with no file, paid on the invoice date", async () => {
    const res = await postReceived([received(), received({ number: "8", paid: false })]);
    expect(outcomes(res)).toEqual(["imported", "imported"]);
    const list = await owner.json<{ received: ReceivedInvoiceRecord[] }>("/api/received");
    const one = list.body.received.find((r) => r.number === "7");
    expect(one).toMatchObject({
      parseStatus: "parsed",
      supplierName: "Tool Shop",
      supplierVat: "98765432109",
      issueDate: "2024-01-05",
      totalCents: 12200,
      paymentFlag: "paid",
      paidDate: "2024-01-05",
      source: "import",
      original: null,
    });
    expect(list.body.received.find((r) => r.number === "8")?.paymentFlag).toBe("unpaid");
    expect((await owner.request(`/api/received/${one?.id}/file`)).status).toBe(404);
  });

  it("reports a second run, the same row twice, and a supplier without VAT by name", async () => {
    expect(outcomes(await postReceived([received(), received({ number: "8" })]))).toEqual([
      "duplicate",
      "duplicate",
    ]);
    const res = await postReceived([
      received({ supplierVat: null, supplierName: "Foreign Co", number: "1" }),
      received({ supplierVat: null, supplierName: "FOREIGN CO", number: "1" }),
      received({ supplierVat: null, supplierName: "Foreign Co", number: "2" }),
    ]);
    expect(outcomes(res)).toEqual(["imported", "duplicate", "imported"]);
  });

  it("is a duplicate of an invoice that arrived through the PEC mailbox", async () => {
    await resetPolling(env.DB);
    const server = openMailbox([{ uid: 1, source: plainMail("seed") }]);
    await pollMailbox(pollEnv);
    server.add({
      uid: 2,
      source: receivedInvoiceMessage({ id: "rx1", content: "<x>invoice</x>" }),
    });
    await pollMailbox(pollEnv);
    const polled = await env.DB.prepare(
      "SELECT id FROM received_invoices WHERE pec_message_id IS NOT NULL",
    ).first<{ id: string }>();
    await env.DB.prepare(
      `UPDATE received_invoices SET parse_status = 'parsed', supplier_name = 'Mail Supplier',
         supplier_vat = 'IT01234567890', number = '123', issue_date = '2026-10-05' WHERE id = ?`,
    )
      .bind(polled?.id)
      .run();
    const res = await postReceived([
      received({
        supplierName: "Mail Supplier",
        supplierVat: "01234567890",
        number: "123",
        issueDate: "2026-10-05",
      }),
    ]);
    expect(res.body.results).toEqual([{ outcome: "duplicate", id: polled?.id }]);
  });

  it("needs a session and a valid body", async () => {
    const anon = new TestClient("10.13.0.4", bindings);
    expect((await anon.json("/api/received/import-summary", { body: { rows: [] } })).status).toBe(
      401,
    );
    expect((await postReceived([])).status).toBe(400);
  });
});
