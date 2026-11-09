import { cleanup, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { type ClientRecord, EMPTY_CLIENT_DEFAULTS } from "../../shared/client";
import { createI18n } from "../i18n";
import { emptyForm, emptyLine, type InvoiceForm } from "../lib/invoice-form";
import { buildInvoiceView } from "../lib/invoice-view";
import { StoredInvoiceView } from "./stored-invoice-view";

afterEach(cleanup);

/** The text of an element with the no-break spaces of the money format as plain spaces. */
const textOf = (element: HTMLElement) => (element.textContent ?? "").replaceAll("\u00a0", " ");

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
  recipientCode: "ABC1234",
  pec: null,
  email: "info@acme.it",
  pdfLanguage: "it",
  currency: "EUR",
  defaults: EMPTY_CLIENT_DEFAULTS,
};

async function show(over: Partial<InvoiceForm>, lng: "en" | "it" = "en") {
  const form: InvoiceForm = {
    ...emptyForm(),
    invoiceDate: "2026-10-15",
    lines: [
      { ...emptyLine(), description: "Design", price: "100,00", vat: "rate:2200" },
      {
        ...emptyLine(),
        description: "<b>Books</b>",
        note: "<i>two</i> copies",
        quantity: "2",
        price: "50,00",
        vat: "rate:1000",
      },
    ],
    termsKind: "invoice_date",
    paymentMethod: "MP05",
    iban: "IT60X0542811101000000123456",
    invoiceNote: "Thanks for <script>x</script> the order",
    ...over,
  };
  const view = buildInvoiceView(form, {
    client,
    seriesName: null,
    linkedNumber: null,
    today: "2026-11-09",
  });
  render(
    <I18nextProvider i18n={await createI18n(lng)}>
      <StoredInvoiceView view={view} locale={lng} cassa={form.cassaType} />
    </I18nextProvider>,
  );
}

describe("StoredInvoiceView", () => {
  it("shows the customer, the lines, the VAT summary, the totals and the payment, without fields", async () => {
    await show({});
    const doc = screen.getByRole("region", { name: "Invoice details" });
    expect(textOf(within(doc).getByRole("group", { name: "Customer" }))).toContain("IT12345678903");
    const lines = within(doc).getByRole("group", { name: "Lines" });
    expect(textOf(lines)).toContain("Design");
    expect(textOf(lines)).toContain("2 × € 50.00 · VAT 10%");
    const summary = within(doc).getByRole("group", { name: "VAT summary" });
    expect(textOf(summary)).toContain("22% on € 100.00");
    expect(textOf(summary)).toContain("€ 22.00");
    const totals = within(doc).getByRole("group", { name: "Totals" });
    expect(textOf(totals)).toContain("€ 200.00");
    expect(textOf(totals)).toContain("€ 232.00");
    expect(textOf(totals)).not.toContain("Amount due");
    const payment = within(doc).getByRole("group", { name: "Payment" });
    expect(textOf(payment)).toContain("Bank transfer");
    expect(textOf(payment)).toContain("IT60X0542811101000000123456");
    expect(textOf(payment)).toContain("15 Oct 2026");
    expect(doc.querySelector("input, select, textarea, button")).toBeNull();
  });

  it("renders stored text as text, never as markup", async () => {
    await show({});
    const doc = screen.getByRole("region", { name: "Invoice details" });
    expect(doc.querySelector("b, i, script")).toBeNull();
    expect(textOf(doc)).toContain("<b>Books</b>");
    expect(textOf(doc)).toContain("<i>two</i> copies");
    expect(textOf(doc)).toContain("Thanks for <script>x</script> the order");
  });

  it("shows the amount due next to the document total when there is a withholding tax", async () => {
    await show({
      lines: [{ ...emptyLine(), description: "Work", price: "1000,00", vat: "rate:2200" }],
      cassaType: "rivalsa_inps",
      cassaRate: "4",
      ritenutaType: "RT01",
      ritenutaRate: "20",
    });
    const totals = within(screen.getByRole("region")).getByRole("group", { name: "Totals" });
    expect(textOf(totals)).toContain("Contribution INPS rivalsa 4%€ 40.00");
    expect(textOf(totals)).toContain("€ 1,268.80");
    expect(textOf(totals)).toContain("−€ 200.00");
    expect(textOf(totals)).toContain("Amount due€ 1,068.80");
  });

  it("says so when there are no lines or the totals are not known yet, and hides an empty payment", async () => {
    await show({ lines: [], termsKind: "", paymentMethod: "", iban: "" });
    expect(screen.getByText("No lines yet.")).toBeTruthy();
    expect(screen.getByText(/The totals appear once every line/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Payment" })).toBeNull();
    expect(screen.queryByRole("group", { name: "VAT summary" })).toBeNull();
  });

  it("is written in the owner's language", async () => {
    await show({}, "it");
    const doc = screen.getByRole("region", { name: "Dettagli della fattura" });
    expect(within(doc).getByRole("group", { name: "Righe" })).toBeTruthy();
    expect(within(doc).getByRole("group", { name: "Pagamento" })).toBeTruthy();
  });
});
