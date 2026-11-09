import {
  EMPTY_INVOICE_DATA,
  type InvoiceBody,
  type InvoiceData,
  type InvoiceLine,
} from "./invoice";
import { dueDate, type PaymentTerms } from "./payment-terms";
import type { CassaDefaults, RitenutaDefaults } from "./tax";
import { NATURA_TEXTS } from "./totals";

/**
 * The single place that turns what an import found (the real lines of a FatturaPA file) into the
 * body of an unsent invoice created through the editor's save path. Callers describe the content
 * as a `DraftSpec`; everything the editor derives from it (payment terms, legal texts per natura)
 * is derived here.
 */

export interface DraftSpec {
  documentType: InvoiceBody["documentType"];
  currency: string;
  date: string;
  lines: InvoiceLine[];
  cassa: CassaDefaults | null;
  ritenuta: RitenutaDefaults | null;
  /** `client`: a generated bollo line; `issuer`: the issuer bears it (no line). */
  bollo: "none" | "client" | "issuer";
  note: string;
  payment: {
    method: InvoiceData["payment"]["method"];
    /** The bank account to copy onto the invoice (an existing payment method), or null. */
    account: Pick<InvoiceData["payment"], "iban" | "bic" | "accountHolder" | "bankName"> | null;
    /** The due date written in the source, turned into payment terms when they reproduce it. */
    dueDate: string | null;
  } | null;
}

export interface DraftContext {
  clientId: string | null;
  seriesId: string | null;
  /** The progressive to ask for, or null when the number is left to the owner. */
  requestedNumber: number | null;
}

const MAX_DAYS = 365;

/**
 * The payment terms that give exactly `due` for an invoice date, or null when none does. Plain
 * days from the invoice date are tried last, so "end of month" terms win when they fit.
 */
export function deriveTerms(date: string, due: string): PaymentTerms | null {
  if (due === date) return { kind: "invoice_date" };
  for (const kind of ["eom_30", "eom_60", "eom_15"] as const) {
    if (dueDate(date, { kind }) === due) return { kind };
  }
  const days = Math.round(
    (new Date(`${due}T00:00:00Z`).getTime() - new Date(`${date}T00:00:00Z`).getTime()) / 86_400_000,
  );
  return Number.isInteger(days) && days > 0 && days <= MAX_DAYS ? { kind: "custom", days } : null;
}

export function assembleDraft(spec: DraftSpec, context: DraftContext): InvoiceBody {
  const terms = spec.payment?.dueDate ? deriveTerms(spec.date, spec.payment.dueDate) : null;
  const naturaTexts: InvoiceData["naturaTexts"] = {};
  for (const line of spec.lines) {
    if (line.natura) naturaTexts[line.natura] = NATURA_TEXTS[line.natura].text;
  }
  return {
    documentType: spec.documentType,
    clientId: context.clientId,
    currency: spec.currency,
    invoiceDate: spec.date,
    dueDate: spec.payment?.dueDate && !terms ? spec.payment.dueDate : null,
    requestedNumber: context.requestedNumber,
    seriesId: context.seriesId,
    linkedInvoiceId: null,
    lines: spec.lines,
    data: {
      ...EMPTY_INVOICE_DATA,
      cassa: spec.cassa,
      ritenuta: spec.ritenuta,
      bollo: spec.bollo !== "none",
      bolloCharge: spec.bollo === "issuer" ? "issuer" : "client",
      note: spec.note,
      naturaTexts,
      payment: {
        ...EMPTY_INVOICE_DATA.payment,
        method: spec.payment?.method ?? null,
        ...(spec.payment?.account ?? {}),
        terms,
      },
    },
  };
}
