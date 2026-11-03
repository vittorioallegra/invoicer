import type { ClientRecord } from "../../shared/client";
import { romeDateTime } from "../../shared/cron";
import {
  defaultNaturaText,
  EMPTY_INVOICE_DATA,
  type InvoiceData,
  type InvoiceInput,
  type InvoiceLanguage,
  type InvoiceLine,
  type InvoiceRecord,
  invoiceInputSchema,
  invoiceLanguage,
  issueMap,
  issuingProblems,
  isValidDate,
  MAX_INVOICE_NUMBER,
  parseQuantityMilli,
  safeTotals,
} from "../../shared/invoice";
import type { PaymentMethodRecord } from "../../shared/payment-method";
import {
  dueDate as computeDueDate,
  type PaymentTerms,
  type PaymentTermsKind,
} from "../../shared/payment-terms";
import { EMPTY_TAX_OPTIONS, type RITENUTA_TYPES, type TaxOptions } from "../../shared/tax";
import {
  type BolloCharge,
  type CassaType,
  type CausalePagamento,
  defaultCassaSubjectToRitenuta,
  divRound,
  type Natura,
  parseMoney,
  type Totals,
} from "../../shared/totals";

export const VAT_RATES = [2200, 1000, 500, 400] as const;

export interface LineForm {
  /** Stable React key; not persisted. */
  key: string;
  description: string;
  /** Optional note under the line. */
  note: string;
  quantity: string;
  unit: string;
  price: string;
  /** `rate:<bp>` or `natura:<code>`; empty until chosen (there is no default). */
  vat: string;
}

export interface InvoiceForm {
  documentType: "TD01" | "TD04";
  clientId: string;
  currency: string;
  /** Language of the PDF and the courtesy email; prefilled from the client, editable. */
  language: InvoiceLanguage;
  /** Number typed by the owner; empty = automatic (the proposed next number). */
  requestedNumber: string;
  /** Numbering series; `""` = the default series. */
  seriesId: string;
  invoiceDate: string;
  /** `""` = no terms. */
  termsKind: "" | PaymentTermsKind;
  /** Days from the invoice date; used by the custom kind only. */
  termsDays: string;
  linkedInvoiceId: string;
  lines: LineForm[];
  cassaType: string;
  cassaRate: string;
  cassaMode: "excluded" | "included";
  cassaSubjectToRitenuta: boolean;
  ritenutaType: string;
  ritenutaRate: string;
  /** Percent of the taxable the ritenuta rate applies to. */
  ritenutaBase: string;
  ritenutaCausale: string;
  bollo: boolean;
  /** Who bears the bollo; `legacy` only on stored issued invoices (never offered). */
  bolloCharge: BolloCharge;
  bolloDismissed: boolean;
  /** Note printed on the invoice. */
  invoiceNote: string;
  naturaTexts: Record<string, string>;
  paymentMethod: string;
  iban: string;
  bic: string;
  accountHolder: string;
  bankName: string;
}

let lineCounter = 0;
export const newLineKey = () => `line-${++lineCounter}`;

/** A new line has no VAT or exemption chosen: the owner picks one per line. */
export function emptyLine(): LineForm {
  return {
    key: newLineKey(),
    description: "",
    note: "",
    quantity: "1",
    unit: "",
    price: "",
    vat: "",
  };
}

export function emptyForm(): InvoiceForm {
  return {
    documentType: "TD01",
    clientId: "",
    currency: "EUR",
    language: "it",
    requestedNumber: "",
    seriesId: "",
    invoiceDate: "",
    termsKind: "",
    termsDays: "",
    linkedInvoiceId: "",
    lines: [emptyLine()],
    cassaType: "",
    cassaRate: "",
    cassaMode: "excluded",
    cassaSubjectToRitenuta: false,
    ritenutaType: "",
    ritenutaRate: "",
    ritenutaBase: "100",
    ritenutaCausale: "A",
    bollo: false,
    bolloCharge: "client",
    bolloDismissed: false,
    invoiceNote: "",
    naturaTexts: {},
    paymentMethod: "",
    iban: "",
    bic: "",
    accountHolder: "",
    bankName: "",
  };
}

export const bpToText = (bp: number) => String(bp / 100).replace(".", ",");

/** "22" or "22,5" to basis points; NaN when it is not a number. */
export function percentToBp(text: string): number {
  const value = Number(text.trim().replace(",", "."));
  return text.trim() === "" || Number.isNaN(value) ? Number.NaN : Math.round(value * 100);
}

export const centsToText = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
const milliToText = (milli: number) => String(milli / 1000).replace(".", ",");

const lineVat = (line: Pick<InvoiceLine, "natura" | "vatRateBp">) =>
  line.natura ? `natura:${line.natura}` : line.vatRateBp ? `rate:${line.vatRateBp}` : "";

/** The editor state of a stored invoice; an unsent one reopens with the raw text as it was typed. */
export function fromRecord(
  record: InvoiceRecord,
  clients: readonly ClientRecord[] = [],
): InvoiceForm {
  const stored = fromStored(record, clients.find((c) => c.id === record.clientId) ?? null);
  const unsent = record.state === "draft" || record.state === "planned";
  if (!unsent) return stored;
  const form = restoreForm(record.editorForm, stored);
  // An unsent invoice was never issued: it moves to the current bollo rule (a line for the client).
  return form.bolloCharge === "legacy" ? { ...form, bolloCharge: "client" } : form;
}

function fromStored(record: InvoiceRecord, client: ClientRecord | null): InvoiceForm {
  const { data } = record;
  return {
    documentType: record.documentType,
    clientId: record.clientId ?? "",
    currency: record.currency,
    language: invoiceLanguage(data, client),
    requestedNumber: record.requestedNumber === null ? "" : String(record.requestedNumber),
    seriesId: record.seriesId,
    invoiceDate: record.invoiceDate ?? "",
    ...termsToForm(data.payment.terms),
    linkedInvoiceId: record.linkedInvoiceId ?? "",
    lines: record.lines.map((line) => ({
      key: newLineKey(),
      description: line.description,
      note: line.note,
      quantity: milliToText(line.quantityMilli),
      unit: line.unit ?? "",
      price: centsToText(line.unitPriceCents),
      vat: lineVat(line),
    })),
    cassaType: data.cassa?.type ?? "",
    cassaRate: data.cassa ? bpToText(data.cassa.rateBp) : "",
    cassaMode: data.cassa?.mode ?? "excluded",
    cassaSubjectToRitenuta: data.cassa?.subjectToRitenuta ?? false,
    ritenutaType: data.ritenuta?.type ?? "",
    ritenutaRate: data.ritenuta ? bpToText(data.ritenuta.rateBp) : "",
    ritenutaBase: data.ritenuta ? bpToText(data.ritenuta.baseBp) : "100",
    ritenutaCausale: data.ritenuta?.causale ?? "A",
    bollo: data.bollo,
    bolloCharge: data.bolloCharge,
    bolloDismissed: data.bolloSuggestionDismissed,
    invoiceNote: data.note,
    naturaTexts: Object.fromEntries(Object.entries(data.naturaTexts)) as Record<string, string>,
    paymentMethod: data.payment.method ?? "",
    iban: data.payment.iban ?? "",
    bic: data.payment.bic ?? "",
    accountHolder: data.payment.accountHolder ?? "",
    bankName: data.payment.bankName ?? "",
  };
}

/**
 * The form saved with an unsent invoice (`editorForm`), read defensively: a field of the wrong
 * type, or any field when the whole value is not an object, takes the fallback's value.
 */
export function restoreForm(raw: unknown, fallback: InvoiceForm): InvoiceForm {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback;
  const saved = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...fallback };
  for (const key of Object.keys(fallback) as (keyof InvoiceForm)[]) {
    if (key === "lines" || key === "naturaTexts") continue;
    if (typeof saved[key] === typeof fallback[key]) out[key] = saved[key];
  }
  if (Array.isArray(saved.lines)) {
    out.lines = saved.lines.map((item) => {
      const line = (typeof item === "object" && item !== null ? item : {}) as Record<
        string,
        unknown
      >;
      const base = emptyLine();
      const text = (key: Exclude<keyof LineForm, "key">) =>
        typeof line[key] === "string" ? (line[key] as string) : base[key];
      return {
        ...base,
        description: text("description"),
        note: text("note"),
        quantity: text("quantity"),
        unit: text("unit"),
        price: text("price"),
        vat: text("vat"),
      };
    });
  }
  const texts = saved.naturaTexts;
  if (typeof texts === "object" && texts !== null && !Array.isArray(texts)) {
    out.naturaTexts = Object.fromEntries(
      Object.entries(texts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  return out as unknown as InvoiceForm;
}

/**
 * The body of a save: what the form says as far as it can be read, plus the form itself as typed
 * (`editorForm`). Saving never validates; unreadable amounts are NaN here and the Worker stores
 * them as 0, while the raw text stays in `editorForm`.
 */
export function draftBody(
  form: InvoiceForm,
  proposal: number | null = null,
  today: string = romeDateTime(new Date()).date,
): InvoiceInput & { editorForm: InvoiceForm } {
  return { ...buildInvoice(form, proposal, today).input, editorForm: form };
}

/** The form fields for stored terms (null = no terms). */
export function termsToForm(terms: PaymentTerms | null | undefined): {
  termsKind: "" | PaymentTermsKind;
  termsDays: string;
} {
  return {
    termsKind: terms?.kind ?? "",
    termsDays: terms?.kind === "custom" ? String(terms.days) : "",
  };
}

/** The terms chosen in the form, or null when none are chosen. */
export function formTerms(form: Pick<InvoiceForm, "termsKind" | "termsDays">): PaymentTerms | null {
  if (form.termsKind === "") return null;
  if (form.termsKind === "custom") return { kind: "custom", days: Number(form.termsDays || 0) };
  return { kind: form.termsKind };
}

/**
 * The due date the invoice is saved with: always computed from the terms (counted from the
 * invoice date, else today); empty without terms.
 */
export function effectiveDueDate(
  form: Pick<InvoiceForm, "termsKind" | "termsDays" | "invoiceDate">,
  today: string,
): string {
  const terms = formTerms(form);
  if (!terms) return "";
  const base = form.invoiceDate.trim() || today;
  return isValidDate(base) ? computeDueDate(base, terms) : "";
}

/**
 * Prefills a new invoice for a client: the currency and payment terms from the client, and the
 * owner's cassa / ritenuta from Tax details when the client's flag for it is on. The values are
 * copied onto the invoice, which keeps its own editable snapshot. VAT is not prefilled and bollo is
 * a manual choice. The bank account is chosen separately (`withAccount`), so picking a client never
 * overrides it.
 */
export function applyDefaults(
  form: InvoiceForm,
  client: ClientRecord | null,
  tax: TaxOptions = EMPTY_TAX_OPTIONS,
): InvoiceForm {
  const next: InvoiceForm = { ...form };
  const defaults = client?.defaults;
  if (client) {
    next.currency = client.currency;
    next.language = client.pdfLanguage;
  }
  // The client's series starts a new invoice; none means the default series.
  next.seriesId = defaults?.seriesId ?? "";
  if (defaults) {
    const cassa = defaults.applyCassa ? tax.cassa : null;
    next.cassaType = cassa?.type ?? "";
    next.cassaRate = cassa ? bpToText(cassa.rateBp) : "";
    next.cassaMode = cassa?.mode ?? "excluded";
    next.cassaSubjectToRitenuta = cassa?.subjectToRitenuta ?? false;
    const ritenuta = defaults.applyRitenuta ? tax.ritenuta : null;
    next.ritenutaType = ritenuta?.type ?? "";
    next.ritenutaRate = ritenuta ? bpToText(ritenuta.rateBp) : "";
    next.ritenutaBase = ritenuta ? bpToText(ritenuta.baseBp) : "100";
    next.ritenutaCausale = ritenuta?.causale ?? "A";
  }
  // Terms prefill from the client default (none = no terms); the due date follows them.
  Object.assign(next, termsToForm(defaults?.terms));
  // Natura legal texts follow the lines.
  next.naturaTexts = naturaTextsFor(next.lines, next.naturaTexts);
  return next;
}

/**
 * Copies a bank account into the invoice's own payment data (the snapshot an invoice keeps;
 * `null` clears it). The payment method becomes bank transfer unless one is already set.
 */
export function withAccount(form: InvoiceForm, account: PaymentMethodRecord | null): InvoiceForm {
  if (!account) return { ...form, iban: "", bic: "", accountHolder: "", bankName: "" };
  return {
    ...form,
    iban: account.iban,
    bic: account.bic ?? "",
    accountHolder: account.accountHolder ?? "",
    bankName: "",
    paymentMethod: form.paymentMethod || "MP05",
  };
}

/** Keeps the legal text of each natura in use (prefilled when new), drops the unused ones. */
export function naturaTextsFor(
  lines: readonly LineForm[],
  current: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    if (!line.vat.startsWith("natura:")) continue;
    const code = line.vat.slice(7) as Natura;
    out[code] = current[code] ?? defaultNaturaText(code);
  }
  return out;
}

export interface BuiltInvoice {
  input: InvoiceInput;
  /** Field problems found while reading the typed text (amounts, quantities, rates). */
  problems: Record<string, string>;
}

const blank = (value: string) => (value.trim() === "" ? null : value.trim());

/** The number typed in the Number field: null when empty, NaN when it is not a whole number. */
export function typedNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  return value >= 1 && value <= MAX_INVOICE_NUMBER ? value : Number.NaN;
}

/**
 * Reads the form into the API shape; unreadable numbers become NaN and are reported. `proposal`
 * is the next free number of the year: a typed number equal to it means "automatic" (null).
 */
export function buildInvoice(
  form: InvoiceForm,
  proposal: number | null = null,
  today: string = romeDateTime(new Date()).date,
): BuiltInvoice {
  const problems: Record<string, string> = {};
  const requested = typedNumber(form.requestedNumber);
  if (Number.isNaN(requested)) problems.requestedNumber = "invalid_number";
  const lines = form.lines.map((line, index) => {
    const price = parseMoney(line.price);
    const quantity = parseQuantityMilli(line.quantity);
    if (line.price.trim() === "") problems[`lines.${index}.unitPriceCents`] = "required";
    else if (price === null || price < 0)
      problems[`lines.${index}.unitPriceCents`] = "invalid_amount";
    if (quantity === null) problems[`lines.${index}.quantityMilli`] = "invalid_quantity";
    return {
      description: line.description,
      note: line.note,
      quantityMilli: quantity ?? Number.NaN,
      unit: blank(line.unit),
      unitPriceCents: price === null || price < 0 ? Number.NaN : price,
      vatRateBp: line.vat.startsWith("rate:") ? Number(line.vat.slice(5)) : null,
      natura: line.vat.startsWith("natura:") ? (line.vat.slice(7) as Natura) : null,
    };
  });
  const cassaRate = percentToBp(form.cassaRate);
  const ritenutaRate = percentToBp(form.ritenutaRate);
  if (form.cassaType && Number.isNaN(cassaRate)) problems["data.cassa.rateBp"] = "invalid_rate";
  if (form.ritenutaType && Number.isNaN(ritenutaRate)) {
    problems["data.ritenuta.rateBp"] = "invalid_rate";
  }
  const ritenutaBase = percentToBp(form.ritenutaBase);
  if (
    form.ritenutaType &&
    (Number.isNaN(ritenutaBase) || ritenutaBase < 1 || ritenutaBase > 10000)
  ) {
    problems["data.ritenuta.baseBp"] = "invalid_rate";
  }
  const data: InvoiceInput["data"] = {
    cassa: form.cassaType
      ? {
          type: form.cassaType as CassaType,
          rateBp: cassaRate,
          mode: form.cassaMode,
          subjectToRitenuta: form.cassaSubjectToRitenuta,
        }
      : null,
    ritenuta: form.ritenutaType
      ? {
          type: form.ritenutaType as (typeof RITENUTA_TYPES)[number],
          rateBp: ritenutaRate,
          baseBp: ritenutaBase,
          causale: form.ritenutaCausale as CausalePagamento,
        }
      : null,
    bollo: form.bollo,
    bolloCharge: form.bolloCharge,
    bolloSuggestionDismissed: form.bolloDismissed,
    note: form.invoiceNote,
    naturaTexts: naturaTextsFor(form.lines, form.naturaTexts),
    language: form.language,
    payment: {
      terms: formTerms(form),
      method: (form.paymentMethod || null) as InvoiceData["payment"]["method"],
      iban: form.iban,
      bic: form.bic,
      accountHolder: form.accountHolder,
      bankName: form.bankName,
    },
  };
  return {
    problems,
    input: {
      documentType: form.documentType,
      clientId: form.clientId || null,
      currency: form.currency,
      requestedNumber: requested === null || requested === proposal ? null : requested,
      seriesId: form.seriesId || null,
      invoiceDate: blank(form.invoiceDate),
      dueDate: blank(effectiveDueDate(form, today)),
      linkedInvoiceId: form.linkedInvoiceId || null,
      lines,
      data,
    },
  };
}

/**
 * Every problem of the form: field problems from the typed text, then the structural rules and,
 * when `issuing`, the rules a number needs (what the XSD and the client type require).
 */
export function validateForm(
  form: InvoiceForm,
  client: ClientRecord | null,
  issuing: boolean,
  proposal: number | null = null,
  today: string = romeDateTime(new Date()).date,
): { errors: Record<string, string>; ok: boolean; body: InvoiceInput } {
  const { input, problems } = buildInvoice(form, proposal, today);
  const parsed = invoiceInputSchema.safeParse(input);
  const rules: Record<string, string> = issuing
    ? Object.fromEntries(
        issuingProblems(
          {
            clientId: input.clientId,
            lines: input.lines,
            data: { naturaTexts: input.data.naturaTexts },
          },
          client,
        ).map((problem) => [problem.path.join("."), problem.code]),
      )
    : {};
  // A number below the proposal is already taken: the Worker would refuse it at send time.
  const requested = typedNumber(form.requestedNumber);
  if (issuing && proposal !== null && requested !== null && requested < proposal) {
    rules.requestedNumber = "number_too_low";
  }
  const errors = { ...(parsed.success ? {} : issueMap(parsed.error)), ...rules, ...problems };
  // Unreadable numbers were NaN: the typed-text problem is the useful message.
  return { errors, ok: Object.keys(errors).length === 0, body: input };
}

/** Totals of what is typed so far; unreadable amounts count as zero while the owner is typing. */
export function formTotals(form: InvoiceForm): Totals | null {
  const { input } = buildInvoice(form);
  const clean = (n: number) => (Number.isFinite(n) ? n : 0);
  const data = invoiceDataFor(input);
  return safeTotals({
    documentType: form.documentType,
    currency: form.currency.toUpperCase(),
    data,
    lines: input.lines.map((line) => ({
      ...line,
      note: line.note ?? "",
      unit: line.unit,
      quantityMilli: clean(line.quantityMilli),
      unitPriceCents: clean(line.unitPriceCents),
    })),
  });
}

/**
 * Amount of each line (quantity x price) as typed so far. It does not depend on the VAT: a line
 * without VAT makes the invoice totals unavailable, but must not blank the other lines' amounts.
 */
export function formLineAmounts(form: InvoiceForm): number[] {
  const clean = (n: number) => (Number.isFinite(n) ? n : 0);
  return buildInvoice(form).input.lines.map((line) =>
    divRound(clean(line.quantityMilli) * clean(line.unitPriceCents), 1000),
  );
}

function invoiceDataFor(input: InvoiceInput): InvoiceData {
  const clean = (n: number) => (Number.isFinite(n) ? n : 0);
  return {
    ...EMPTY_INVOICE_DATA,
    cassa: input.data.cassa
      ? { ...input.data.cassa, rateBp: clean(input.data.cassa.rateBp) }
      : null,
    ritenuta: input.data.ritenuta
      ? {
          ...input.data.ritenuta,
          rateBp: clean(input.data.ritenuta.rateBp),
          baseBp: clean(input.data.ritenuta.baseBp ?? 10000),
        }
      : null,
    bollo: input.data.bollo,
    bolloCharge: input.data.bolloCharge ?? "client",
    bolloSuggestionDismissed: input.data.bolloSuggestionDismissed,
  };
}

export { defaultCassaSubjectToRitenuta };
