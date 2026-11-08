import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ImportFileOutcome, XmlDraft } from "../../shared/import";
import type { InvoiceRecord } from "../../shared/invoice";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";

const bindings = env as unknown as Bindings;
let owner: TestClient;

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.14.0.1", bindings));
  owner = new TestClient("10.14.0.2", bindings);
  await signIn(owner);
});

const line = (description: string, unitPriceCents: number, extra: object = {}) => ({
  description,
  note: "",
  quantityMilli: 1000,
  unit: null,
  unitPriceCents,
  vatRateBp: 2200,
  natura: null,
  ...extra,
});
const client = {
  type: "it_company",
  name: "Real Lines Srl",
  vatNumber: "12345678903",
  taxCode: "",
  foreignTaxId: "",
  countryCode: "IT",
  address: "Via Prova 1",
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
const draft = (over: Partial<XmlDraft> = {}): XmlDraft => ({
  documentType: "TD01",
  number: "11",
  date: "2099-11-30",
  currency: "EUR",
  customer: {
    name: "Real Lines Srl",
    vatCountry: "IT",
    vatCode: "12345678903",
    taxCode: null,
    client,
  },
  lines: [line("First work", 4000), line("Exempt work", 1000, { vatRateBp: null, natura: "N2.2" })],
  cassa: null,
  ritenuta: null,
  bollo: "none",
  note: "",
  payment: null,
  ...over,
});
const post = (body: unknown) =>
  owner.json<ImportFileOutcome | { outcome: "invalid" }>("/api/invoices/import-draft", { body });
const invoiceOf = async (result: unknown) =>
  (await owner.json<{ invoice: InvoiceRecord }>(`/api/invoices/${(result as { id: string }).id}`))
    .body.invoice;

describe("POST /api/invoices/import-draft", () => {
  it("needs a session and a valid body", async () => {
    const anon = new TestClient("10.14.0.3", bindings);
    expect((await anon.json("/api/invoices/import-draft", { body: draft() })).status).toBe(401);
    expect((await post({ ...draft(), lines: [] })).status).toBe(400);
    expect((await post(draft({ date: "30/11/2099" }))).status).toBe(400);
  });

  it("creates an unsent invoice with the real lines and creates the client from the file", async () => {
    const res = await post(draft());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ outcome: "imported", clientLinked: true });
    const invoice = await invoiceOf(res.body);
    expect(invoice).toMatchObject({
      source: "app",
      state: "planned",
      paymentFlag: "unpaid",
      invoiceDate: "2099-11-30",
      number: null,
      requestedNumber: 11,
      clientName: "Real Lines Srl",
      hasOriginal: false,
    });
    expect(
      invoice.lines.map((l) => [l.description, l.unitPriceCents, l.vatRateBp, l.natura]),
    ).toEqual([
      ["First work", 4000, 2200, null],
      ["Exempt work", 1000, null, "N2.2"],
    ]);
    expect(invoice.data.naturaTexts["N2.2"]).toBeTruthy();
    const clients = await env.DB.prepare(
      "SELECT count(*) AS n FROM clients WHERE vat_number = '12345678903'",
    ).first<{ n: number }>();
    expect(clients?.n).toBe(1);
    // No original file is stored for a draft.
    const files = await env.DB.prepare("SELECT count(*) AS n FROM files WHERE invoice_id = ?")
      .bind(invoice.id)
      .first<{ n: number }>();
    expect(files?.n).toBe(0);
  });

  it("is a duplicate the second time and links the client it created before", async () => {
    expect((await post(draft())).body).toMatchObject({ outcome: "duplicate" });
    const next = await post(draft({ number: "12", date: "2099-12-31" }));
    expect(next.body).toMatchObject({ outcome: "imported", clientLinked: true });
    const clients = await env.DB.prepare(
      "SELECT count(*) AS n FROM clients WHERE vat_number = '12345678903'",
    ).first<{ n: number }>();
    expect(clients?.n).toBe(1);
    expect((await post(draft({ date: "2099-10-01" }))).body).toMatchObject({
      outcome: "number_conflict",
    });
  });

  it("maps cassa, ritenuta, bollo, note, terms and the bank account with the same IBAN", async () => {
    await owner.json("/api/payment-methods", {
      body: { label: "Main", iban: "IT60X0542811101000000123456", bic: "", accountHolder: "Me" },
    });
    const res = await post(
      draft({
        number: "13",
        date: "2099-12-15",
        cassa: { type: "rivalsa_inps", rateBp: 400, mode: "excluded", subjectToRitenuta: true },
        ritenuta: { type: "RT01", rateBp: 2000, baseBp: 10000, causale: "A" },
        bollo: "issuer",
        note: "Thanks",
        payment: {
          method: "MP05",
          iban: "IT60 X054 2811 1010 0000 0123 456",
          dueDate: "2100-01-31",
        },
      }),
    );
    const invoice = await invoiceOf(res.body);
    expect(invoice.data).toMatchObject({
      cassa: { type: "rivalsa_inps", rateBp: 400 },
      ritenuta: { type: "RT01", rateBp: 2000 },
      bollo: true,
      bolloCharge: "issuer",
      note: "Thanks",
      payment: {
        method: "MP05",
        iban: "IT60X0542811101000000123456",
        accountHolder: "Me",
        terms: { kind: "eom_30" },
      },
    });
  });

  it("keeps the payment method but no account when the IBAN is unknown, and a due date no terms give", async () => {
    const res = await post(
      draft({
        number: "14",
        date: "2099-12-16",
        payment: { method: "MP05", iban: "IT28W8000000292100645211208", dueDate: "2099-12-20" },
      }),
    );
    const invoice = await invoiceOf(res.body);
    expect(invoice.data.payment).toMatchObject({
      method: "MP05",
      iban: null,
      terms: { kind: "custom", days: 4 },
    });
  });
});
