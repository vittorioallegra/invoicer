import type { ClientRecord } from "../../shared/client";
import type { InvoiceLanguage } from "../../shared/invoice";
import type { PaymentTerms } from "../../shared/payment-terms";
import type { Natura, Totals } from "../../shared/totals";
import {
  buildInvoice,
  effectiveDueDate,
  formLineAmounts,
  formTerms,
  formTotals,
  type InvoiceForm,
} from "./invoice-form";

/** A line of the compact view: the typed quantity and unit, the price and VAT, the amount in cents. */
export interface ViewLine {
  description: string;
  note: string;
  /** Quantity as typed (`2,5`), "" when empty. */
  quantity: string;
  unit: string;
  /** Unit price in cents; null when it is not a valid amount yet. */
  unitPriceCents: number | null;
  vatRateBp: number | null;
  natura: Natura | null;
  /** Quantity x unit price, rounded to the cent (what the editor shows as the line amount). */
  amountCents: number;
}

export interface ViewCustomer {
  /** Country code plus VAT number (or the foreign tax id) and the codice fiscale. */
  vatId: string | null;
  taxCode: string | null;
  /** One line: street, "postal code city (province)", country. */
  address: string;
  recipientCode: string | null;
  pec: string | null;
  email: string | null;
}

export interface ViewPayment {
  terms: PaymentTerms | null;
  dueDate: string | null;
  method: string | null;
  iban: string | null;
  bic: string | null;
  accountHolder: string | null;
  bankName: string | null;
}

/** What the compact (view mode) page of a stored invoice shows. Pure data, no formatting. */
export interface InvoiceView {
  currency: string;
  credit: boolean;
  /** The stamp duty is applied and borne by the issuer: nothing is added to the totals. */
  stampBorneByIssuer: boolean;
  customer: ViewCustomer | null;
  note: string;
  /** The series name, only when there is more than one series to tell apart. */
  seriesName: string | null;
  language: InvoiceLanguage;
  /** The printed number of the invoice a credit note refers to. */
  linkedNumber: string | null;
  lines: ViewLine[];
  /** The totals engine's result; null without lines or while a line has no VAT yet (a draft). */
  totals: Totals | null;
  payment: ViewPayment;
}

const text = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

export function customerView(client: ClientRecord): ViewCustomer {
  const italian = client.countryCode === "IT";
  const vat = text(client.vatNumber) ?? text(client.foreignTaxId);
  const place = [
    [client.postalCode, client.city].map(text).filter(Boolean).join(" "),
    text(client.province) ? `(${text(client.province)})` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    vatId: vat ? (client.vatNumber && italian ? `${client.countryCode}${vat}` : vat) : null,
    taxCode: text(client.taxCode),
    address: [text(client.address), place, text(client.countryCode)].filter(Boolean).join(", "),
    recipientCode: text(client.recipientCode),
    pec: text(client.pec),
    email: text(client.email),
  };
}

/**
 * Maps the stored form of an invoice (`fromRecord`) to the compact view: the same cents the
 * editor's totals engine computes, never FatturaPA XML (a draft is not complete enough for it).
 */
export function buildInvoiceView(
  form: InvoiceForm,
  options: {
    client: ClientRecord | null;
    seriesName: string | null;
    linkedNumber: string | null;
    today: string;
  },
): InvoiceView {
  const amounts = formLineAmounts(form);
  const built = buildInvoice(form).input.lines;
  const finite = (n: number) => (Number.isFinite(n) ? n : null);
  return {
    currency: form.currency.toUpperCase() || "EUR",
    credit: form.documentType === "TD04",
    stampBorneByIssuer: form.bollo && form.bolloCharge === "issuer",
    customer: options.client ? customerView(options.client) : null,
    note: form.invoiceNote.trim(),
    seriesName: options.seriesName,
    language: form.language,
    linkedNumber: options.linkedNumber,
    lines: form.lines.map((line, index) => ({
      description: line.description,
      note: line.note.trim(),
      quantity: line.quantity.trim(),
      unit: line.unit.trim(),
      unitPriceCents: finite(built[index]?.unitPriceCents ?? Number.NaN),
      vatRateBp: built[index]?.vatRateBp ?? null,
      natura: built[index]?.natura ?? null,
      amountCents: amounts[index] ?? 0,
    })),
    totals: form.lines.length > 0 ? formTotals(form) : null,
    payment: {
      terms: formTerms(form),
      dueDate: text(effectiveDueDate(form, options.today)),
      method: text(form.paymentMethod),
      iban: text(form.iban),
      bic: text(form.bic),
      accountHolder: text(form.accountHolder),
      bankName: text(form.bankName),
    },
  };
}
