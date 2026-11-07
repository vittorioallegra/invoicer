import { z } from "zod";
import { type ClientRecord, clientInputSchema, clientRecordToInput } from "./client";
import type { InvoiceState, PaymentState } from "./invoice-state";
import { paymentDefaultsSchema } from "./payment-method";
import { paymentTermsSchema } from "./payment-terms";
import { cassaDefaultsSchema, ritenutaDefaultsSchema } from "./tax";
import {
  BOLLO_CHARGES,
  computeTotals,
  DOCUMENT_TYPES,
  NATURA_CODES,
  NATURA_TEXTS,
  type Natura,
  type Totals,
  type TotalsInput,
  type TotalsLine,
} from "./totals";

/**
 * Invoice editor rules shared by the browser (live inline validation) and the Worker (the same
 * schemas run again on save and before a number is reserved). Validation messages are stable
 * codes the UI translates; `path: code` pairs travel in problem+json `detail`.
 */

/** FatturaPA `ModalitaPagamento` codes the editor offers. */
export const PAYMENT_METHODS = ["MP01", "MP02", "MP05", "MP08", "MP12", "MP19", "MP23"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Days after a rejection (NS) in which the same number and date may still be resent. */
export const REJECTION_WINDOW_DAYS = 5;
/** Event type the polling step records for an SdI rejection (payload: `{ errors: [...] }`). */
export const REJECTION_EVENT_TYPE = "NS";

const DAY_MS = 86_400_000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date written `YYYY-MM-DD` (the XSD accepts years from 1970). */
export function isValidDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value &&
    parsed.getUTCFullYear() >= 1970
  );
}

const dateOnly = z.string().refine(isValidDate, "invalid_date");

/** FatturaPA `Descrizione` is limited to 1000 characters (String1000LatinType). */
export const LINE_TEXT_MAX = 1000;

/** Characters the line text takes in `Descrizione`: the description, then the note on a new line. */
export function lineTextLength(line: { description: string; note?: string | undefined }): number {
  const description = line.description.trim().length;
  const note = (line.note ?? "").trim().length;
  return note > 0 ? description + 1 + note : description;
}

export const invoiceLineSchema = z
  .object({
    /** FatturaPA `Descrizione` (required when issuing); with the note it fits 1000 characters. */
    description: z.string().trim().max(LINE_TEXT_MAX),
    /** Optional note, written after the description on a new line of `Descrizione`. */
    note: z.string().trim().max(LINE_TEXT_MAX, "line_text_too_long").default(""),
    /** Quantity in thousandths (1000 = 1). */
    quantityMilli: z.number().int().min(1).max(999_999_999_999),
    unit: z
      .string()
      .trim()
      .max(10)
      .nullable()
      .transform((value) => value || null),
    unitPriceCents: z.number().int().min(0).max(9_999_999_999_999),
    vatRateBp: z.number().int().min(1).max(10000).nullable(),
    natura: z.enum(NATURA_CODES).nullable(),
  })
  .refine((line) => !(line.vatRateBp !== null && line.natura !== null), {
    message: "invalid_vat_default",
    path: ["natura"],
  })
  .refine((line) => lineTextLength(line) <= LINE_TEXT_MAX, {
    message: "line_text_too_long",
    path: ["note"],
  });
export type InvoiceLine = z.output<typeof invoiceLineSchema>;

/** Payment data: stored values come back as null for "empty", which the schema accepts again. */
export const invoicePaymentSchema = z.preprocess(
  (value) => {
    if (typeof value !== "object" || value === null) return value;
    const text = { ...(value as Record<string, unknown>) };
    for (const key of ["iban", "bic", "accountHolder", "bankName"]) text[key] ??= "";
    return text;
  },
  paymentDefaultsSchema.extend({
    method: z.enum(PAYMENT_METHODS).nullable(),
    /** Payment terms (one of five choices); the due date is always computed from the issue date. */
    terms: paymentTermsSchema.nullable().default(null),
  }),
);

/** Longest invoice note: about ten `Causale` elements of 200 characters. */
export const INVOICE_NOTE_MAX = 2000;

export const INVOICE_LANGUAGES = ["it", "en"] as const;
export type InvoiceLanguage = (typeof INVOICE_LANGUAGES)[number];

/** The language of an invoice's PDF and email: its own, else the client's, else Italian. */
export function invoiceLanguage(
  data: Pick<InvoiceData, "language">,
  client: { pdfLanguage: InvoiceLanguage } | null | undefined,
): InvoiceLanguage {
  return data.language ?? client?.pdfLanguage ?? "it";
}

export const invoiceDataSchema = z.object({
  cassa: cassaDefaultsSchema.nullable(),
  ritenuta: ritenutaDefaultsSchema.nullable(),
  bollo: z.boolean(),
  /**
   * Who bears the bollo: the client (a generated 2.00 line) or the issuer (no line). Invoices
   * stored before the choice existed read as `legacy` (2.00 in the total, no line) so their
   * totals never change; the editor never offers it.
   */
  bolloCharge: z.enum(BOLLO_CHARGES).default("legacy"),
  /** The owner dismissed the "add bollo" suggestion for this invoice. */
  bolloSuggestionDismissed: z.boolean(),
  /**
   * Note printed on the invoice (PDF) and sent in the XML as `Causale` elements.
   */
  note: z.string().trim().max(INVOICE_NOTE_MAX, "note_too_long").default(""),
  /** Legal text per natura code used by the lines (prefilled from `NATURA_TEXTS`, editable). */
  naturaTexts: z.partialRecord(z.enum(NATURA_CODES), z.string().trim().max(1000)),
  payment: invoicePaymentSchema,
  /**
   * Language of this invoice's PDF and courtesy email, chosen per invoice (prefilled from the
   * client). Null on invoices stored before the field existed: they follow the client's language
   * (`invoiceLanguage`).
   */
  language: z.enum(INVOICE_LANGUAGES).nullable().default(null),
});
export type InvoiceData = z.output<typeof invoiceDataSchema>;

export const EMPTY_INVOICE_DATA: InvoiceData = {
  cassa: null,
  ritenuta: null,
  bollo: false,
  bolloCharge: "client",
  bolloSuggestionDismissed: false,
  note: "",
  naturaTexts: {},
  language: null,
  payment: {
    method: null,
    iban: null,
    bic: null,
    accountHolder: null,
    bankName: null,
    terms: null,
  },
};

/** Largest number the owner may request (keeps the number a safe, printable integer). */
export const MAX_INVOICE_NUMBER = 999_999_999;

export const invoiceInputSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  clientId: z.string().min(1).nullable(),
  currency: z
    .string()
    .transform((value) => value.replaceAll(/\s+/g, "").toUpperCase())
    .refine((value) => /^[A-Z]{3}$/.test(value), "invalid_currency"),
  /**
   * The invoice date ("Data fattura"): the XML `Data`, the numbering year and the base of the
   * payment terms. Null = the day the invoice is sent. A future date on an unnumbered invoice lists
   * it as planned (stored in the `planned_date` column).
   */
  invoiceDate: dateOnly.nullable(),
  dueDate: dateOnly.nullable(),
  /** Number the owner asked for; null = automatic (the next free number of the year). */
  requestedNumber: z.number().int().min(1).max(MAX_INVOICE_NUMBER).nullable().default(null),
  /** Numbering series; null = the default series. Fixed once the number is reserved. */
  seriesId: z.string().min(1).nullable().default(null),
  /** TD04 only: the invoice the credit note corrects (DatiFattureCollegate). */
  linkedInvoiceId: z.string().min(1).nullable(),
  lines: z.array(invoiceLineSchema).max(500),
  data: invoiceDataSchema,
});
export type InvoiceInput = z.input<typeof invoiceInputSchema>;
export type InvoiceBody = z.output<typeof invoiceInputSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The parsed value, or the fallback when the schema refuses it. */
function orFallback<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

const textOf = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function draftLine(raw: unknown): InvoiceLine {
  const line = isRecord(raw) ? raw : {};
  const vatRateBp = orFallback(z.number().int().min(1).max(10000).nullable(), line.vatRateBp, null);
  const natura = orFallback(z.enum(NATURA_CODES).nullable(), line.natura, null);
  return {
    description: textOf(line.description),
    note: textOf(line.note),
    quantityMilli: clampInt(line.quantityMilli, 0, 999_999_999_999, 0),
    unit: textOf(line.unit).slice(0, 10) || null,
    unitPriceCents: clampInt(line.unitPriceCents, 0, 9_999_999_999_999, 0),
    vatRateBp,
    natura: vatRateBp === null ? natura : null,
  };
}

function draftData(raw: unknown): InvoiceData {
  const data = isRecord(raw) ? raw : {};
  const payment = isRecord(data.payment) ? data.payment : {};
  const texts = isRecord(data.naturaTexts) ? data.naturaTexts : {};
  const empty = EMPTY_INVOICE_DATA.payment;
  return {
    cassa: orFallback(cassaDefaultsSchema.nullable(), data.cassa, null),
    ritenuta: orFallback(ritenutaDefaultsSchema.nullable(), data.ritenuta, null),
    bollo: data.bollo === true,
    bolloCharge: orFallback(z.enum(BOLLO_CHARGES), data.bolloCharge, "legacy"),
    bolloSuggestionDismissed: data.bolloSuggestionDismissed === true,
    note: textOf(data.note),
    language: orFallback(z.enum(INVOICE_LANGUAGES).nullable(), data.language, null),
    naturaTexts: Object.fromEntries(
      NATURA_CODES.flatMap((code) =>
        typeof texts[code] === "string" ? [[code, texts[code]]] : [],
      ),
    ),
    payment: orFallback(invoicePaymentSchema, payment, {
      ...empty,
      method: orFallback(z.enum(PAYMENT_METHODS).nullable(), payment.method, null),
      terms: orFallback(paymentTermsSchema.nullable(), payment.terms, null),
    }),
  };
}

/**
 * Reads the body of a save. Saving never judges an invoice: content that satisfies the invoice
 * schema is taken as is, and anything else is stored as far as it can be (an unreadable amount
 * becomes 0, an invalid date none), so the invoice may be incomplete or wrong. Every check runs
 * when the invoice is finalised. Null only when the body is not an invoice at all (not an
 * object, or more lines than can be stored).
 */
export function parseInvoiceDraft(raw: unknown): InvoiceBody | null {
  const strict = invoiceInputSchema.safeParse(raw);
  if (strict.success) return strict.data;
  if (!isRecord(raw) || !Array.isArray(raw.lines) || raw.lines.length > 500) return null;
  const id = z.string().min(1).nullable();
  return {
    documentType: orFallback(z.enum(DOCUMENT_TYPES), raw.documentType, "TD01"),
    clientId: orFallback(id, raw.clientId, null),
    currency:
      typeof raw.currency === "string"
        ? raw.currency.replaceAll(/\s+/g, "").toUpperCase().slice(0, 3)
        : "EUR",
    invoiceDate: orFallback(dateOnly.nullable(), raw.invoiceDate, null),
    dueDate: orFallback(dateOnly.nullable(), raw.dueDate, null),
    requestedNumber: orFallback(
      z.number().int().min(1).max(MAX_INVOICE_NUMBER).nullable(),
      raw.requestedNumber,
      null,
    ),
    seriesId: orFallback(id, raw.seriesId, null),
    linkedInvoiceId: orFallback(id, raw.linkedInvoiceId, null),
    lines: raw.lines.map(draftLine),
    data: draftData(raw.data),
  };
}

/** Payment flag: the only thing that changes once an invoice is out. */
export const invoiceMetaSchema = z
  .object({
    paymentFlag: z.enum(["unpaid", "paid"]),
    paidDate: dateOnly.nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "empty");

/** Totals engine input for an invoice body, or null while a line has neither VAT nor natura. */
export function invoiceTotalsInput(
  invoice: Pick<InvoiceBody, "documentType" | "currency" | "lines" | "data">,
): TotalsInput {
  const lines: TotalsLine[] = invoice.lines.map((line) => ({
    description: line.description,
    quantityMilli: line.quantityMilli,
    unitPriceCents: line.unitPriceCents,
    vatRateBp: line.vatRateBp,
    natura: line.natura,
  }));
  return {
    documentType: invoice.documentType,
    currency: invoice.currency,
    lines,
    cassa: invoice.data.cassa,
    ritenuta: invoice.data.ritenuta,
    bollo: invoice.data.bollo,
    bolloCharge: invoice.data.bolloCharge,
  };
}

/** Computes the totals, or null when the lines are not complete enough to be totalled. */
export function safeTotals(
  invoice: Pick<InvoiceBody, "documentType" | "currency" | "lines" | "data">,
): Totals | null {
  if (invoice.lines.some((line) => line.vatRateBp === null && line.natura === null)) return null;
  try {
    return computeTotals(invoiceTotalsInput(invoice));
  } catch {
    return null;
  }
}

/**
 * Whether the "add bollo" suggestion applies: exempt amounts above 77.47 EUR, bollo not yet
 * applied or dismissed.
 * Open question (docs/plans/invoicer.md, "Bollo on non-EUR invoices", fixture d): the stamp is a
 * EUR amount, so nothing is suggested for a non-EUR invoice until the owner decides how it is
 * totalled; the totals engine itself is unchanged.
 */
export function bolloSuggestion(
  totals: Totals | null,
  invoice: Pick<InvoiceBody, "currency" | "data">,
): boolean {
  return (
    totals?.bolloSuggested === true &&
    invoice.currency === "EUR" &&
    !invoice.data.bollo &&
    !invoice.data.bolloSuggestionDismissed
  );
}

/**
 * Parses a typed quantity (`2`, `7,5`, `0.125`) into thousandths, or null when it is not a
 * positive number with at most three decimals.
 */
export function parseQuantityMilli(input: string): number | null {
  const text = input.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,3})?$/.test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  const milli = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
  return Number.isSafeInteger(milli) && milli > 0 ? milli : null;
}

/** Natura legal text to prefill when a natura is first used. */
export function defaultNaturaText(natura: Natura): string {
  return NATURA_TEXTS[natura].text;
}

/** Days after the invoice date within which an invoice must be transmitted (art. 21 DPR 633/72). */
export const TRANSMISSION_TERM_DAYS = 12;

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Non-blocking warning for a late transmission: an invoice dated in the past must reach the SdI
 * within 12 days of its date (art. 21 DPR 633/72, as amended by DL 119/2018). There is no
 * deferred-invoice mode: the owner issues such an invoice with the date of the operation, within
 * this term.
 */
export function transmissionTermWarning(input: {
  invoiceDate: string | null;
  sendDate: string;
}): boolean {
  const { invoiceDate, sendDate } = input;
  if (!invoiceDate || !isValidDate(invoiceDate) || !isValidDate(sendDate)) return false;
  return daysBetween(invoiceDate, sendDate) > TRANSMISSION_TERM_DAYS;
}

/** How much of an invoice the owner may change in each state. */
export type Editability = "full" | "rejected" | "locked";

export function invoiceEditability(state: InvoiceState): Editability {
  if (state === "draft" || state === "planned") return "full";
  if (state === "rejected") return "rejected";
  return "locked";
}

/** End of the resend window of a rejection, as epoch milliseconds. */
export function rejectionDeadline(rejectedAtMs: number): number {
  return rejectedAtMs + REJECTION_WINDOW_DAYS * DAY_MS;
}

export interface RejectionInfo {
  at: number;
  deadline: number;
  /** SdI error codes and texts, as received. Rendered as plain text only. */
  errors: { code: string; description: string }[];
}

/**
 * Editor field an SdI error code points at, so the error text can sit next to it: `client` for
 * recipient data and `lines` for VAT/natura on the lines. Other codes have no single field and
 * are only listed in the banner.
 *
 * Checked against the official SdI controls (Allegato A, Specifiche tecniche, v1.6, section on the
 * checks of the Sistema di Interscambio; verified 2026-11-02):
 * - 00305 `1.4.1.1.2 <IdCodice>` of the cessionario/committente not valid (client);
 * - 00306 `1.4.1.2 <CodiceFiscale>` of the cessionario/committente not valid (client);
 * - 00311 `1.1.4 <CodiceDestinatario>` not valid (client recipient code);
 * - 00417 `1.4.1.1 <IdFiscaleIVA>` and `1.4.1.2 <CodiceFiscale>` both missing (client);
 * - 00400 Natura missing for a zero VAT rate, 00401 Natura present for a non-zero rate (lines).
 */
export const SDI_ERROR_FIELDS: Readonly<Record<string, "client" | "lines">> = {
  "00305": "client",
  "00306": "client",
  "00311": "client",
  "00417": "client",
  "00400": "lines",
  "00401": "lines",
};

/** An invoice as the API returns it. */
export interface InvoiceRecord {
  id: string;
  /** `imported` = a historic invoice read from a file: stored `delivered` and read-only. */
  source: "app" | "imported";
  documentType: "TD01" | "TD04";
  state: InvoiceState;
  /** Stored flag with `overdue` derived: unpaid, issued and past its due date. */
  paymentFlag: PaymentState;
  paidDate: string | null;
  clientId: string | null;
  /** The client's name, else the customer name kept by a summary import. */
  clientName: string | null;
  /** An imported invoice has its original file stored (a summary import has none). */
  hasOriginal: boolean;
  /** Number as printed; null while draft or planned. */
  number: string | null;
  /** Number the owner asked for on a draft or planned invoice; null = automatic. */
  requestedNumber: number | null;
  /** Numbering series of the invoice (always set: the default series when none was chosen). */
  seriesId: string;
  year: number | null;
  issueDate: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string;
  totalCents: number | null;
  linkedInvoiceId: string | null;
  /** Number and date of the linked invoice, for the credit note reference. */
  linked: { number: string | null; issueDate: string | null } | null;
  /** The rejected invoice this one reissues. */
  reissuesInvoiceId: string | null;
  lines: InvoiceLine[];
  data: InvoiceData;
  /** The editor form as typed at the last save (raw text); null when never saved from the editor. */
  editorForm: unknown;
  /** Number reserved but nothing handed to the PEC yet: it can be sent or released. */
  numberReserved: boolean;
  /** The reserved number is the highest of its year, so it can be released. */
  releasable: boolean;
  rejection: RejectionInfo | null;
  /** A reissue draft already exists for this rejected_expired invoice. */
  reissuedById: string | null;
}

export type InvoiceSummary = Pick<
  InvoiceRecord,
  | "id"
  | "source"
  | "documentType"
  | "state"
  | "paymentFlag"
  | "clientName"
  | "number"
  | "year"
  | "issueDate"
  | "invoiceDate"
  | "dueDate"
  | "currency"
  | "totalCents"
  | "numberReserved"
  | "releasable"
  | "linkedInvoiceId"
> & { rejectionDeadline: number | null };

export const INVOICE_LIST_SCOPES = ["to_issue", "issued", "reserved"] as const;
export type InvoiceListScope = (typeof INVOICE_LIST_SCOPES)[number];

export interface IssuingProblem {
  path: (string | number)[];
  code: string;
}

/**
 * Rules that must hold before a number is reserved: what the XSD and the client type require.
 * `client` is the stored client of the invoice; its own type rules are checked with the client
 * schema and reported under `client.<field>`. Pure, so the editor can run it while other fields
 * are still unreadable.
 */
export function issuingProblems(
  invoice: {
    clientId: string | null;
    lines: { description: string; vatRateBp: number | null; natura: Natura | null }[];
    data: { naturaTexts: Partial<Record<Natura, string | undefined>> };
  },
  client: ClientRecord | null,
): IssuingProblem[] {
  const out: IssuingProblem[] = [];
  const fail = (path: (string | number)[], code: string) => out.push({ path, code });

  if (invoice.clientId === null || client === null) {
    fail(["clientId"], "required");
  } else {
    const parsed = clientInputSchema.safeParse(clientRecordToInput(client));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        fail(["client", ...issue.path.map(String)], issueCode(issue));
      }
    }
  }
  if (invoice.lines.length === 0) fail(["lines"], "required");
  invoice.lines.forEach((line, index) => {
    if (line.description.trim() === "") fail(["lines", index, "description"], "required");
    if (line.vatRateBp === null && line.natura === null)
      fail(["lines", index, "vat"], "vat_required");
  });
  const used = new Set(invoice.lines.flatMap((line) => (line.natura ? [line.natura] : [])));
  for (const natura of used) {
    if (!invoice.data.naturaTexts[natura]?.trim()) {
      fail(["data", "naturaTexts", natura], "natura_text_required");
    }
  }
  return out;
}

/** The invoice schema plus the issuing rules, for the Worker before it reserves a number. */
export function invoiceIssuableSchema(client: ClientRecord | null) {
  return invoiceInputSchema.superRefine((invoice, ctx) => {
    for (const problem of issuingProblems(invoice, client)) {
      ctx.addIssue({ code: "custom", path: problem.path, message: problem.code });
    }
  });
}

function issueCode(issue: z.core.$ZodIssue): string {
  if (/^[a-z_]+$/.test(issue.message)) return issue.message;
  return issue.code === "too_small" ? "required" : "invalid";
}

/** `path: code` pairs from a failed parse, first issue per path, like the server `detail`. */
export function issueMap(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "body";
    if (key in out) continue;
    out[key] = issueCode(issue);
  }
  return out;
}
