import { describe, expect, it } from "vitest";
import { type ClientRecord, EMPTY_CLIENT_DEFAULTS } from "../../shared/client";
import { emptyForm, emptyLine, type InvoiceForm, type LineForm } from "./invoice-form";
import { buildInvoiceView, customerView } from "./invoice-view";

const acme: ClientRecord = {
  id: "c1",
  type: "it_company",
  name: "Acme S.r.l.",
  vatNumber: "12345678903",
  taxCode: "12345678903",
  foreignTaxId: null,
  countryCode: "IT",
  address: "Via Roma 1",
  postalCode: "00100",
  city: "Roma",
  province: "RM",
  recipientCode: "ABC1234",
  pec: "acme@pec.it",
  email: "info@acme.it",
  pdfLanguage: "it",
  currency: "EUR",
  defaults: EMPTY_CLIENT_DEFAULTS,
};

const swiss: ClientRecord = {
  ...acme,
  id: "c2",
  type: "non_eu_company",
  name: "Alpen AG",
  vatNumber: null,
  taxCode: null,
  foreignTaxId: "CHE-123.456.789",
  countryCode: "CH",
  address: "Bahnhofstrasse 5",
  postalCode: "8001",
  city: "Zurich",
  province: null,
  recipientCode: "XXXXXXX",
  pec: null,
  email: null,
};

const line = (over: Partial<LineForm>): LineForm => ({ ...emptyLine(), ...over });
const form = (over: Partial<InvoiceForm>): InvoiceForm => ({ ...emptyForm(), ...over });
const options = { client: acme, seriesName: null, linkedNumber: null, today: "2026-11-09" };

describe("buildInvoiceView", () => {
  it("lists the lines with their amounts and groups the VAT summary by rate", () => {
    const view = buildInvoiceView(
      form({
        lines: [
          line({ description: "Design", quantity: "1", price: "100,00", vat: "rate:2200" }),
          line({
            description: "Books",
            note: "Two copies",
            quantity: "2,5",
            unit: "pcs",
            price: "40,00",
            vat: "rate:1000",
          }),
        ],
      }),
      options,
    );
    expect(view.lines).toEqual([
      expect.objectContaining({
        description: "Design",
        quantity: "1",
        unitPriceCents: 10000,
        vatRateBp: 2200,
        natura: null,
        amountCents: 10000,
      }),
      expect.objectContaining({
        description: "Books",
        note: "Two copies",
        quantity: "2,5",
        unit: "pcs",
        unitPriceCents: 4000,
        vatRateBp: 1000,
        amountCents: 10000,
      }),
    ]);
    const totals = view.totals;
    expect(totals?.groups.map((g) => [g.vatRateBp, g.taxableCents, g.vatCents])).toEqual([
      [2200, 10000, 2200],
      [1000, 10000, 1000],
    ]);
    expect(totals?.documentTotalCents).toBe(23200);
    expect(totals?.amountDueCents).toBe(23200);
  });

  it("carries the contribution and the withholding tax of the totals engine", () => {
    const view = buildInvoiceView(
      form({
        lines: [line({ description: "Work", price: "1000,00", vat: "rate:2200" })],
        cassaType: "rivalsa_inps",
        cassaRate: "4",
        ritenutaType: "RT01",
        ritenutaRate: "20",
        ritenutaBase: "100",
      }),
      options,
    );
    expect(view.totals).toMatchObject({
      taxableWithoutContributionCents: 100000,
      contributionCents: 4000,
      taxableCents: 104000,
      vatCents: 22880,
      documentTotalCents: 126880,
      ritenutaCents: 20000,
      amountDueCents: 106880,
    });
  });

  it("charges the stamp duty to the client as a generated line, or leaves it to the issuer", () => {
    const exempt = [line({ description: "Advice", price: "100,00", vat: "natura:N4" })];
    const charged = buildInvoiceView(form({ lines: exempt, bollo: true }), options);
    expect(charged.stampBorneByIssuer).toBe(false);
    expect(charged.totals?.stampLine?.totals.amountCents).toBe(200);
    expect(charged.totals?.documentTotalCents).toBe(10200);
    const issuer = buildInvoiceView(
      form({ lines: exempt, bollo: true, bolloCharge: "issuer" }),
      options,
    );
    expect(issuer.stampBorneByIssuer).toBe(true);
    expect(issuer.totals?.stampLine).toBeNull();
    expect(issuer.totals?.documentTotalCents).toBe(10000);
  });

  it("shows a foreign client with its tax id, and a line with a natura instead of a rate", () => {
    const view = buildInvoiceView(
      form({
        currency: "chf",
        language: "en",
        lines: [line({ description: "Export", price: "300,00", vat: "natura:N2.1" })],
      }),
      { ...options, client: swiss },
    );
    expect(view.currency).toBe("CHF");
    expect(view.language).toBe("en");
    expect(view.customer).toEqual({
      vatId: "CHE-123.456.789",
      taxCode: null,
      address: "Bahnhofstrasse 5, 8001 Zurich, CH",
      recipientCode: "XXXXXXX",
      pec: null,
      email: null,
    });
    expect(view.lines[0]).toMatchObject({ vatRateBp: null, natura: "N2.1" });
    expect(view.totals?.groups).toEqual([
      expect.objectContaining({ natura: "N2.1", taxableCents: 30000, vatCents: 0 }),
    ]);
  });

  it("computes the due date from the terms, the invoice date and today, and keeps the bank details", () => {
    const view = buildInvoiceView(
      form({
        invoiceDate: "2026-10-15",
        termsKind: "eom_30",
        paymentMethod: "MP05",
        iban: "IT60X0542811101000000123456",
        bic: "BPMOIT22",
        accountHolder: "Mario Rossi",
        bankName: "Fineco",
        lines: [line({ description: "x", price: "1,00", vat: "rate:2200" })],
      }),
      options,
    );
    expect(view.payment).toEqual({
      terms: { kind: "eom_30" },
      dueDate: "2026-11-30",
      method: "MP05",
      iban: "IT60X0542811101000000123456",
      bic: "BPMOIT22",
      accountHolder: "Mario Rossi",
      bankName: "Fineco",
    });
    const custom = buildInvoiceView(
      form({ termsKind: "custom", termsDays: "10", lines: [] }),
      options,
    );
    // Without an invoice date the terms count from today.
    expect(custom.payment).toMatchObject({
      terms: { kind: "custom", days: 10 },
      dueDate: "2026-11-19",
    });
    const none = buildInvoiceView(form({}), options);
    expect(none.payment).toMatchObject({ terms: null, dueDate: null, method: null, iban: null });
  });

  it("handles an invoice without lines, or with a line still missing its VAT", () => {
    const empty = buildInvoiceView(form({ lines: [] }), options);
    expect(empty.lines).toEqual([]);
    expect(empty.totals).toBeNull();
    const draft = buildInvoiceView(
      form({ lines: [line({ description: "Half done", price: "10,00" })] }),
      options,
    );
    // The amount shows, the totals wait for a VAT rate.
    expect(draft.lines[0]).toMatchObject({ amountCents: 1000, vatRateBp: null, natura: null });
    expect(draft.totals).toBeNull();
  });

  it("marks a credit note, names the series and carries the note and linked number", () => {
    const view = buildInvoiceView(
      form({ documentType: "TD04", invoiceNote: "  Refund of 5/2026 " }),
      { ...options, seriesName: "Svizzera", linkedNumber: "5" },
    );
    expect(view).toMatchObject({
      credit: true,
      note: "Refund of 5/2026",
      seriesName: "Svizzera",
      linkedNumber: "5",
    });
  });
});

describe("customerView", () => {
  it("prefixes an Italian VAT number with the country and writes the address on one line", () => {
    expect(customerView(acme)).toEqual({
      vatId: "IT12345678903",
      taxCode: "12345678903",
      address: "Via Roma 1, 00100 Roma (RM), IT",
      recipientCode: "ABC1234",
      pec: "acme@pec.it",
      email: "info@acme.it",
    });
  });
});
