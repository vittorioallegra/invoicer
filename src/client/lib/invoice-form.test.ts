import { describe, expect, it } from "vitest";
import { type ClientRecord, EMPTY_CLIENT_DEFAULTS } from "../../shared/client";
import { applyDefaults, buildInvoice, emptyForm, formTotals, validateForm } from "./invoice-form";

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
    paymentTermsDays: 30,
  },
};

describe("invoice form", () => {
  it("prefills from the client defaults and the profile payment defaults", () => {
    const form = applyDefaults(
      emptyForm(),
      client,
      {
        name: "X",
        vatNumber: "12345678903",
        taxCode: null,
        address: null,
        postalCode: null,
        city: null,
        province: null,
        country: "IT",
        regimeFiscale: "RF01",
        paymentDefaults: {
          iban: "IT60X0542811101000000123456",
          bic: null,
          accountHolder: "X",
          bankName: null,
        },
        defaultPaymentTermsDays: 15,
      },
      "2026-01-20",
    );
    expect(form).toMatchObject({
      currency: "USD",
      cassaType: "TC04",
      cassaMode: "included",
      dueDate: "2026-02-19",
      paymentMethod: "MP05",
      iban: "IT60X0542811101000000123456",
    });
    expect(form.lines[0]?.vat).toBe("natura:N2.1");
    expect(form.naturaTexts["N2.1"]).toContain("7-ter");
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
