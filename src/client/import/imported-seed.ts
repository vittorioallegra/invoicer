import type { ClientRecord } from "../../shared/client";
import type { InvoiceRecord } from "../../shared/invoice";
import { PAYMENT_METHODS } from "../../shared/invoice";
import { assembleDraft, type DraftSpec } from "../../shared/invoice-draft";
import type { PaymentMethodRecord } from "../../shared/payment-method";
import { fromRecord, type InvoiceForm } from "../lib/invoice-form";
import type { OriginalInvoice } from "./original";
import { xmlDraftFromInvoice } from "./xml-draft";

/**
 * The starting form of the editor for an imported invoice that was never edited (it has no lines
 * yet). `xml`: the real content of the stored original; `summary`: a summary import has no file,
 * so one line carries the stored total (the owner chooses its VAT); `unreadable`: the original
 * could not be read, so the line is empty. Whatever the source, the invoice keeps its own client,
 * number, series, date, document type, currency and due date: they are the facts of what was
 * issued, never re-derived from the file.
 */
export type SeedSource = "xml" | "summary" | "unreadable";

export interface ImportedSeed {
  form: InvoiceForm;
  source: SeedSource;
}

const PLACEHOLDER_CUSTOMER = {
  name: "-",
  vatCountry: null,
  vatCode: null,
  taxCode: null,
  client: null,
} as const;

export function seedImportedForm(
  record: InvoiceRecord,
  clients: readonly ClientRecord[],
  accounts: readonly PaymentMethodRecord[],
  original: OriginalInvoice | null | "unreadable",
): ImportedSeed {
  const date = record.invoiceDate ?? record.issueDate ?? "";
  const draft =
    original && original !== "unreadable"
      ? xmlDraftFromInvoice(original.invoice, PLACEHOLDER_CUSTOMER)
      : null;
  let spec: DraftSpec;
  let source: SeedSource;
  if (draft) {
    const iban = draft.payment?.iban?.replaceAll(/\s+/g, "").toUpperCase() ?? null;
    const account = iban ? accounts.find((entry) => entry.iban === iban) : undefined;
    source = "xml";
    spec = {
      documentType: record.documentType,
      currency: record.currency,
      date,
      lines: draft.lines,
      cassa: draft.cassa,
      ritenuta: draft.ritenuta,
      bollo: draft.bollo,
      note: draft.note,
      payment: draft.payment
        ? {
            method: PAYMENT_METHODS.find((code) => code === draft.payment?.method) ?? null,
            account: iban
              ? {
                  iban: account?.iban ?? iban,
                  bic: account?.bic ?? null,
                  accountHolder: account?.accountHolder ?? null,
                  bankName: null,
                }
              : null,
            dueDate: record.dueDate,
          }
        : record.dueDate
          ? { method: null, account: null, dueDate: record.dueDate }
          : null,
    };
  } else {
    source = original === "unreadable" ? "unreadable" : "summary";
    spec = {
      documentType: record.documentType,
      currency: record.currency,
      date,
      lines: [
        {
          description: "",
          note: "",
          quantityMilli: 1000,
          unit: null,
          unitPriceCents: source === "summary" ? Math.max(0, record.totalCents ?? 0) : 0,
          vatRateBp: null,
          natura: null,
        },
      ],
      cassa: null,
      ritenuta: null,
      bollo: "none",
      note: "",
      payment: record.dueDate ? { method: null, account: null, dueDate: record.dueDate } : null,
    };
  }
  const body = assembleDraft(spec, {
    clientId: record.clientId,
    seriesId: record.seriesId,
    requestedNumber: null,
  });
  const seeded: InvoiceRecord = {
    ...record,
    lines: body.lines,
    data: body.data,
    editorForm: null,
  };
  return { form: fromRecord(seeded, clients), source };
}
