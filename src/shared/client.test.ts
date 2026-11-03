import { describe, expect, it } from "vitest";
import {
  clientDefaultsSchema,
  clientInputSchema,
  EMPTY_CLIENT_DEFAULTS,
  isValidClientTaxCode,
  isValidPersonalTaxCode,
  newClientDefaults,
} from "./client";

const base = {
  type: "it_company",
  name: "Acme S.r.l.",
  vatNumber: "12345678903",
  taxCode: "",
  foreignTaxId: "",
  countryCode: "IT",
  address: "Via Roma 1",
  postalCode: "00100",
  city: "Roma",
  province: "rm",
  recipientCode: "",
  pec: "",
  email: "",
  pdfLanguage: "it",
  currency: "EUR",
  defaults: EMPTY_CLIENT_DEFAULTS,
} as const;

const parse = (overrides: Record<string, unknown>) =>
  clientInputSchema.safeParse({ ...base, ...overrides });
const codes = (overrides: Record<string, unknown>) => {
  const result = parse(overrides);
  return result.success
    ? {}
    : Object.fromEntries(result.error.issues.map((i) => [i.path.join("."), i.message]));
};

describe("tax identifiers", () => {
  it("checks the codice fiscale check character", () => {
    expect(isValidPersonalTaxCode("RSSMRA85T10A562S")).toBe(true);
    expect(isValidPersonalTaxCode("RSSMRA85T10A562X")).toBe(false);
    expect(isValidPersonalTaxCode("RSSMRA85T10A56")).toBe(false);
  });
  it("accepts an 11-digit company code and rejects a bad check digit", () => {
    expect(isValidClientTaxCode("12345678903")).toBe(true);
    expect(isValidClientTaxCode("12345678904")).toBe(false);
  });
});

describe("Italian company", () => {
  it("defaults the codice destinatario and normalizes input", () => {
    const result = parse({ vatNumber: "IT 12345678903" });
    expect(result.success && result.data).toMatchObject({
      vatNumber: "12345678903",
      recipientCode: "0000000",
      province: "RM",
      foreignTaxId: null,
    });
  });
  it("keeps an explicit channel code and a PEC", () => {
    const result = parse({ recipientCode: "abc1234", pec: "a@pec.it" });
    expect(result.success && result.data).toMatchObject({
      recipientCode: "ABC1234",
      pec: "a@pec.it",
    });
  });
  it("requires a valid partita IVA and a 7-character code", () => {
    expect(codes({ vatNumber: "" })).toEqual({ vatNumber: "required" });
    expect(codes({ vatNumber: "12345678904" })).toEqual({ vatNumber: "invalid_vat_number" });
    expect(codes({ recipientCode: "ABC" })).toEqual({ recipientCode: "invalid_recipient_code" });
  });
  it("requires an Italian address", () => {
    expect(codes({ postalCode: "1234", province: "", address: "" })).toEqual({
      address: "required",
      postalCode: "invalid_postal_code",
      province: "invalid_province",
    });
  });
});

describe("Italian private person", () => {
  const person = { type: "it_private", vatNumber: "", taxCode: "rssmra85t10a562s" };
  it("needs a personal codice fiscale and always gets 0000000", () => {
    const result = parse({ ...person, recipientCode: "ABC1234" });
    expect(result.success && result.data).toMatchObject({
      taxCode: "RSSMRA85T10A562S",
      recipientCode: "0000000",
      vatNumber: null,
    });
    expect(codes({ ...person, taxCode: "" })).toEqual({ taxCode: "required" });
    expect(codes({ ...person, taxCode: "12345678903" })).toEqual({ taxCode: "invalid_tax_code" });
  });
});

describe("foreign clients", () => {
  const eu = {
    type: "eu_company",
    vatNumber: "",
    countryCode: "de",
    foreignTaxId: "DE123456789",
    postalCode: "10115",
    province: "",
  };
  it("gets XXXXXXX, no province and no PEC", () => {
    const result = parse({ ...eu, pec: "x@pec.it", recipientCode: "ABC1234" });
    expect(result.success && result.data).toMatchObject({
      countryCode: "DE",
      recipientCode: "XXXXXXX",
      province: null,
      pec: null,
      foreignTaxId: "DE123456789",
    });
  });
  it("requires the EU VAT id and an EU country other than Italy", () => {
    expect(codes({ ...eu, foreignTaxId: "" })).toEqual({ foreignTaxId: "required" });
    expect(codes({ ...eu, countryCode: "US" })).toEqual({ countryCode: "invalid_eu_country" });
    expect(codes({ ...eu, countryCode: "IT" })).toEqual({ countryCode: "invalid_eu_country" });
  });
  it("non-EU companies need a non-EU country and may omit the tax id", () => {
    const nonEu = { ...eu, type: "non_eu_company", countryCode: "US", foreignTaxId: "" };
    expect(parse(nonEu).success).toBe(true);
    expect(codes({ ...nonEu, countryCode: "FR" })).toEqual({
      countryCode: "invalid_non_eu_country",
    });
    expect(codes({ ...nonEu, address: "" })).toEqual({ address: "required" });
  });
});

describe("defaults", () => {
  it("accepts the cassa and ritenuta flags with terms", () => {
    const defaults = { applyCassa: true, applyRitenuta: false, terms: { kind: "eom_30" } };
    expect(parse({ defaults }).success).toBe(true);
  });
  it("starts a new client with the cassa on and the ritenuta only for Italian companies", () => {
    expect(newClientDefaults("it_company")).toMatchObject({
      applyCassa: true,
      applyRitenuta: true,
    });
    for (const type of ["it_private", "eu_company", "non_eu_company"] as const) {
      expect(newClientDefaults(type)).toMatchObject({ applyCassa: true, applyRitenuta: false });
    }
  });
  it("reads the older shape: the flags mean a cassa / ritenuta was set, VAT and bollo are dropped", () => {
    const parsed = clientDefaultsSchema.parse({
      vatRateBp: 2200,
      natura: null,
      cassa: { type: "TC22", rateBp: 400, mode: "included", subjectToRitenuta: true },
      ritenuta: null,
      bollo: true,
      terms: { kind: "eom_30" },
    });
    expect(parsed).toEqual({ applyCassa: true, applyRitenuta: false, terms: { kind: "eom_30" } });
    const bare = clientDefaultsSchema.parse({
      vatRateBp: null,
      natura: "N2.2",
      cassa: null,
      ritenuta: { type: "RT01", rateBp: 2000, causale: "A" },
      bollo: false,
    });
    expect(bare).toEqual({ applyCassa: false, applyRitenuta: true, terms: null });
  });
  it("keeps the new flags over any older value", () => {
    const parsed = clientDefaultsSchema.parse({
      applyCassa: false,
      applyRitenuta: true,
      cassa: {},
    });
    expect(parsed).toMatchObject({ applyCassa: false, applyRitenuta: true });
  });
  it("maps the older numeric payment terms to the same days from the invoice date", () => {
    const read = (legacy: number | null) => {
      const parsed = clientDefaultsSchema.parse({ paymentTermsDays: legacy });
      return { terms: parsed.terms, hasLegacy: "paymentTermsDays" in parsed };
    };
    expect(read(30)).toEqual({ terms: { kind: "custom", days: 30 }, hasLegacy: false });
    expect(read(45).terms).toEqual({ kind: "custom", days: 45 });
    expect(read(0).terms).toEqual({ kind: "invoice_date" });
    expect(read(null).terms).toBeNull();
  });
  it("reads the previous stored terms shape", () => {
    const read = (terms: unknown) =>
      clientDefaultsSchema.parse({ ...EMPTY_CLIENT_DEFAULTS, terms }).terms;
    expect(read({ days: 30, basis: "end_of_month", extraDays: 0 })).toEqual({ kind: "eom_30" });
    expect(read({ days: 45, basis: "invoice_date", extraDays: 0 })).toEqual({
      kind: "custom",
      days: 45,
    });
  });
  it("rejects terms outside the allowed kinds and days", () => {
    const bad = (terms: unknown) =>
      parse({ defaults: { ...EMPTY_CLIENT_DEFAULTS, terms } }).success;
    expect(bad({ kind: "custom", days: 366 })).toBe(false);
    expect(bad({ kind: "month" })).toBe(false);
    expect(bad({ kind: "custom", days: 45 })).toBe(true);
    expect(bad({ kind: "eom_60" })).toBe(true);
  });
});
