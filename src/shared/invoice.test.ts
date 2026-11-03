import { describe, expect, it } from "vitest";
import { type ClientRecord, EMPTY_CLIENT_DEFAULTS } from "./client";
import {
  bolloSuggestion,
  EMPTY_INVOICE_DATA,
  type InvoiceBody,
  invoiceEditability,
  invoiceInputSchema,
  invoiceIssuableSchema,
  issueMap,
  parseQuantityMilli,
  REJECTION_WINDOW_DAYS,
  rejectionDeadline,
  SDI_ERROR_FIELDS,
  safeTotals,
  transmissionTermWarning,
} from "./invoice";

const client: ClientRecord = {
  id: "c1",
  type: "it_company",
  name: "Acme S.r.l.",
  vatNumber: "12345678903",
  taxCode: null,
  foreignTaxId: null,
  countryCode: "IT",
  address: "Via Roma 1",
  postalCode: "00100",
  city: "Roma",
  province: "RM",
  recipientCode: "0000000",
  pec: null,
  email: null,
  pdfLanguage: "it",
  currency: "EUR",
  defaults: EMPTY_CLIENT_DEFAULTS,
};

const line = { description: "Work", quantityMilli: 1000, unit: null, unitPriceCents: 10000 };
const input = (over: Record<string, unknown> = {}) => ({
  documentType: "TD01",
  clientId: "c1",
  currency: "EUR",
  invoiceDate: null,
  dueDate: null,
  linkedInvoiceId: null,
  notes: null,
  lines: [{ ...line, vatRateBp: 2200, natura: null }],
  data: EMPTY_INVOICE_DATA,
  ...over,
});

const issues = (over: Record<string, unknown> = {}, c: ClientRecord | null = client) => {
  const parsed = invoiceIssuableSchema(c).safeParse(input(over));
  return parsed.success ? {} : issueMap(parsed.error);
};

describe("transmission-term warning (art. 21 DPR 633/72)", () => {
  const invoiceDate = "2026-03-10";
  it("allows an invoice to be sent up to 12 days after its date", () => {
    expect(transmissionTermWarning({ invoiceDate, sendDate: "2026-03-10" })).toBe(false);
    expect(transmissionTermWarning({ invoiceDate, sendDate: "2026-03-22" })).toBe(false);
    expect(transmissionTermWarning({ invoiceDate, sendDate: "2026-03-23" })).toBe(true);
  });
  it("counts across month and year ends", () => {
    expect(transmissionTermWarning({ invoiceDate: "2026-12-20", sendDate: "2027-01-01" })).toBe(
      false,
    );
    expect(transmissionTermWarning({ invoiceDate: "2026-12-20", sendDate: "2027-01-02" })).toBe(
      true,
    );
  });
  it("stays silent without an invoice date", () => {
    expect(transmissionTermWarning({ invoiceDate: null, sendDate: "2026-03-10" })).toBe(false);
  });
});

describe("line notes", () => {
  const withNote = (description: string, note?: string) =>
    issues({ lines: [{ ...line, vatRateBp: 2200, natura: null, description, note }] });
  it("are optional and default to empty", () => {
    expect(issues()).toEqual({});
    const parsed = invoiceInputSchema.parse(input());
    expect(parsed.lines[0]?.note).toBe("");
  });
  it("share the 1000 characters of Descrizione with the description", () => {
    expect(withNote("D".repeat(500), "N".repeat(499))).toEqual({});
    expect(withNote("D".repeat(500), "N".repeat(500))).toMatchObject({
      "lines.0.note": "line_text_too_long",
    });
    expect(withNote("D", "N".repeat(1001))).toMatchObject({ "lines.0.note": "line_text_too_long" });
  });
});

describe("issuing rules", () => {
  it("accepts a complete invoice", () => {
    expect(issues()).toEqual({});
  });
  it("needs a client, a line and a description", () => {
    expect(issues({ clientId: null }, null)).toMatchObject({ clientId: "required" });
    expect(issues({ lines: [] })).toMatchObject({ lines: "required" });
    expect(
      issues({ lines: [{ ...line, description: "", vatRateBp: 2200, natura: null }] }),
    ).toMatchObject({ "lines.0.description": "required" });
  });
  it("needs a VAT rate or a natura on each line, not both", () => {
    expect(issues({ lines: [{ ...line, vatRateBp: null, natura: null }] })).toMatchObject({
      "lines.0.vat": "vat_required",
    });
    expect(issues({ lines: [{ ...line, vatRateBp: 2200, natura: "N4" }] })).toMatchObject({
      "lines.0.natura": "invalid_vat_default",
    });
  });
  it("needs a legal text for every natura in use", () => {
    const withNatura = { lines: [{ ...line, vatRateBp: null, natura: "N2.2" }] };
    expect(issues(withNatura)).toMatchObject({ "data.naturaTexts.N2.2": "natura_text_required" });
    const data = { ...EMPTY_INVOICE_DATA, naturaTexts: { "N2.2": "Art. 1, commi 54-89" } };
    expect(issues({ ...withNatura, data })).toEqual({});
  });
  it("applies the client type rules and names the client field", () => {
    const broken = { ...client, vatNumber: "12345678900", postalCode: "12" };
    expect(issues({}, broken)).toMatchObject({
      "client.vatNumber": "invalid_vat_number",
      "client.postalCode": "invalid_postal_code",
    });
  });
  it("checks IBAN and dates", () => {
    const data = {
      ...EMPTY_INVOICE_DATA,
      payment: { ...EMPTY_INVOICE_DATA.payment, iban: "IT00000000000000000000000" },
    };
    expect(issues({ data })).toMatchObject({ "data.payment.iban": "invalid_iban" });
    expect(issues({ dueDate: "2026-02-30" })).toMatchObject({ dueDate: "invalid_date" });
  });
  it("lets a draft be saved incomplete", () => {
    expect(invoiceInputSchema.safeParse(input({ clientId: null, lines: [] })).success).toBe(true);
  });
});

describe("bollo suggestion", () => {
  const exempt = (currency: string, data = EMPTY_INVOICE_DATA): InvoiceBody => {
    const parsed = invoiceInputSchema.parse(
      input({
        currency,
        lines: [{ ...line, unitPriceCents: 10000, vatRateBp: null, natura: "N4" }],
        data,
      }),
    );
    return parsed;
  };
  it("suggests the stamp for exempt amounts above 77.47 EUR", () => {
    const body = exempt("EUR");
    expect(bolloSuggestion(safeTotals(body), body)).toBe(true);
  });
  it("is silent once applied or dismissed", () => {
    const applied = exempt("EUR", { ...EMPTY_INVOICE_DATA, bollo: true });
    expect(bolloSuggestion(safeTotals(applied), applied)).toBe(false);
    const dismissed = exempt("EUR", { ...EMPTY_INVOICE_DATA, bolloSuggestionDismissed: true });
    expect(bolloSuggestion(safeTotals(dismissed), dismissed)).toBe(false);
  });
  it("is never suggested on a non-EUR invoice (open question: bollo on non-EUR)", () => {
    const body = exempt("USD");
    expect(safeTotals(body)?.bolloSuggested).toBe(true);
    expect(bolloSuggestion(safeTotals(body), body)).toBe(false);
  });
});

describe("state rules", () => {
  it("allows editing only drafts and, within the window, rejected invoices", () => {
    expect(invoiceEditability("draft")).toBe("full");
    expect(invoiceEditability("planned")).toBe("full");
    expect(invoiceEditability("rejected")).toBe("rejected");
    for (const state of [
      "sending",
      "sent",
      "delivered",
      "not_delivered",
      "rejected_expired",
    ] as const) {
      expect(invoiceEditability(state)).toBe("locked");
    }
  });
  it("closes the resend window five days after the rejection", () => {
    expect(rejectionDeadline(0)).toBe(REJECTION_WINDOW_DAYS * 86_400_000);
  });
});

describe("quantity parsing", () => {
  it("reads whole and decimal quantities into thousandths", () => {
    expect(parseQuantityMilli("2")).toBe(2000);
    expect(parseQuantityMilli("7,5")).toBe(7500);
    expect(parseQuantityMilli("0.125")).toBe(125);
  });
  it("refuses zero, negatives, extra decimals and text", () => {
    for (const bad of ["", "0", "-1", "1,2345", "abc", "1.2.3"]) {
      expect(parseQuantityMilli(bad)).toBeNull();
    }
  });
});

describe("SdI error code fields", () => {
  it("points the verified SdI codes at the client or the lines", () => {
    // 00305/00306 cessionario IdCodice/CodiceFiscale, 00311 CodiceDestinatario, 00417 no fiscal id.
    for (const code of ["00305", "00306", "00311", "00417"]) {
      expect(SDI_ERROR_FIELDS[code], code).toBe("client");
    }
    // 00400/00401 Natura against AliquotaIVA.
    for (const code of ["00400", "00401"]) expect(SDI_ERROR_FIELDS[code], code).toBe("lines");
    expect(SDI_ERROR_FIELDS["00423"]).toBeUndefined();
  });
});
