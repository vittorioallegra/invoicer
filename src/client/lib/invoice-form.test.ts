import { describe, expect, it } from "vitest";
import { type ClientRecord, EMPTY_CLIENT_DEFAULTS } from "../../shared/client";
import {
  applyDefaults,
  buildInvoice,
  effectiveDueDate,
  emptyForm,
  formTotals,
  typedNumber,
  validateForm,
  withAccount,
} from "./invoice-form";

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
  currency: "USD",
  defaults: {
    ...EMPTY_CLIENT_DEFAULTS,
    natura: "N2.1",
    cassa: { type: "TC04", rateBp: 400, mode: "included", subjectToRitenuta: false },
    terms: { kind: "custom", days: 30 },
  },
};

describe("invoice form", () => {
  it("prefills from the client defaults", () => {
    const form = applyDefaults(emptyForm(), client);
    expect(form).toMatchObject({
      currency: "USD",
      cassaType: "TC04",
      cassaMode: "included",
      termsDays: "30",
      termsKind: "custom",
      dueDateCustom: false,
    });
    expect(form.lines[0]?.vat).toBe("natura:N2.1");
    expect(form.naturaTexts["N2.1"]).toContain("7-ter");
  });

  it("saves the due date computed from the terms, from the planned date or today", () => {
    const form = applyDefaults(emptyForm(), client);
    expect(effectiveDueDate(form, "2026-01-20")).toBe("2026-02-19");
    expect(effectiveDueDate({ ...form, plannedDate: "2026-03-05" }, "2026-01-20")).toBe(
      "2026-04-04",
    );
    const monthEnd = { ...form, termsKind: "eom_30" as const };
    expect(effectiveDueDate(monthEnd, "2026-01-20")).toBe("2026-02-28");
    expect(buildInvoice(monthEnd, null, "2026-11-10").input.dueDate).toBe("2026-12-31");
    expect(buildInvoice(monthEnd, null, "2026-11-10").input.data.payment).toMatchObject({
      terms: { kind: "eom_30" },
      dueDateCustom: false,
    });
  });

  it("keeps a custom due date, and a typed date when there are no terms", () => {
    const base = applyDefaults(emptyForm(), client);
    const custom = { ...base, dueDateCustom: true, dueDate: "2026-02-03" };
    expect(effectiveDueDate(custom, "2026-01-20")).toBe("2026-02-03");
    expect(buildInvoice(custom, null, "2026-01-20").input.data.payment).toMatchObject({
      dueDateCustom: true,
    });
    const none = { ...emptyForm(), dueDate: "2026-05-01" };
    expect(effectiveDueDate(none, "2026-01-20")).toBe("2026-05-01");
    expect(buildInvoice(none, null, "2026-01-20").input.data.payment).toMatchObject({
      terms: null,
      dueDateCustom: false,
    });
  });

  it("starts without terms and without a due date when the client has no default", () => {
    const form = applyDefaults(emptyForm(), { ...client, defaults: EMPTY_CLIENT_DEFAULTS });
    expect(form.termsDays).toBe("");
    expect(effectiveDueDate(form, "2026-01-20")).toBe("");
  });

  it("copies a bank account into the invoice and clears it again", () => {
    const account = {
      id: "a",
      label: "Fineco",
      iban: "IT60X0542811101000000123456",
      bic: "FINEITMM",
      accountHolder: "X",
      isDefault: true,
    };
    const filled = withAccount(emptyForm(), account);
    expect(filled).toMatchObject({
      paymentMethod: "MP05",
      iban: account.iban,
      bic: "FINEITMM",
      bankName: "",
      accountHolder: "X",
    });
    expect(buildInvoice(filled).input.data.payment).toMatchObject({ iban: account.iban });
    expect(withAccount({ ...filled, paymentMethod: "MP08" }, account).paymentMethod).toBe("MP08");
    expect(withAccount(filled, null)).toMatchObject({ iban: "", bic: "", bankName: "" });
  });

  it("reads typed amounts into cents and totals them live", () => {
    const form = { ...emptyForm(), currency: "EUR" };
    form.lines = [
      {
        key: "a",
        description: "Work",
        quantity: "7,5",
        unit: "h",
        price: "1.040,00",
        vat: "rate:2200",
      },
    ];
    const { input, problems } = buildInvoice(form);
    expect(problems).toEqual({});
    expect(input.lines[0]).toMatchObject({ quantityMilli: 7500, unitPriceCents: 104000 });
    expect(formTotals(form)?.taxableCents).toBe(780000);
  });

  it("reports unreadable amounts and keeps totalling the rest", () => {
    const form = emptyForm();
    form.lines = [
      { key: "a", description: "A", quantity: "1", unit: "", price: "oops", vat: "rate:2200" },
      { key: "b", description: "B", quantity: "1", unit: "", price: "10", vat: "rate:2200" },
    ];
    expect(buildInvoice(form).problems).toEqual({ "lines.0.unitPriceCents": "invalid_amount" });
    expect(formTotals(form)?.taxableCents).toBe(1000);
    expect(validateForm(form, client, false).ok).toBe(false);
  });
});

describe("requested invoice number", () => {
  const withNumber = (requestedNumber: string) => ({ ...emptyForm(), requestedNumber });

  it("reads whole numbers from 1, blank as automatic and anything else as invalid", () => {
    expect(typedNumber("")).toBeNull();
    expect(typedNumber(" 12 ")).toBe(12);
    for (const bad of ["0", "-3", "1.5", "ab", "1000000000"]) {
      expect(typedNumber(bad)).toBeNaN();
    }
  });

  it("sends null for blank or for the proposal, and the number otherwise", () => {
    expect(buildInvoice(withNumber(""), 8).input.requestedNumber).toBeNull();
    expect(buildInvoice(withNumber("8"), 8).input.requestedNumber).toBeNull();
    expect(buildInvoice(withNumber("9"), 8).input.requestedNumber).toBe(9);
    expect(buildInvoice(withNumber("ab"), 8).problems.requestedNumber).toBe("invalid_number");
  });

  it("blocks issuing a number below the proposal, but still allows saving the draft", () => {
    expect(validateForm(withNumber("3"), client, true, 8).errors.requestedNumber).toBe(
      "number_too_low",
    );
    expect(validateForm(withNumber("3"), client, false, 8).errors.requestedNumber).toBeUndefined();
    expect(validateForm(withNumber("20"), client, true, 8).errors.requestedNumber).toBeUndefined();
  });
});
