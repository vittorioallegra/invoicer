import type { ClientRecord, RITENUTA_TYPES } from "../../shared/client";
import { romeDateTime } from "../../shared/cron";
import {
  defaultNaturaText,
  EMPTY_INVOICE_DATA,
  type InvoiceData,
  type InvoiceInput,
  type InvoiceLine,
  type InvoiceRecord,
  invoiceInputSchema,
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
import {
  type CassaType,
  type CausalePagamento,
  defaultCassaSubjectToRitenuta,
  type Natura,
  parseMoney,
  type Totals,
} from "../../shared/totals";

export const VAT_RATES = [2200, 1000, 500, 400] as const;
/** Default VAT rate of a new line when the client has no default. */
export const FALLBACK_VAT_BP = 2200;

export interface LineForm {
  /** Stable React key; not persisted. */
  key: string;
  description: string;
  quantity: string;
  unit: string;
  price: string;
  /** `rate:<bp>` or `natura:<code>`. */
  vat: string;
}

export interface InvoiceForm {
  documentType: "TD01" | "TD04";
  clientId: string;
  currency: string;
  /** Number typed by the owner; empty = automatic (the proposed next number). */
  requestedNumber: string;
  plannedDate: string;
  operationDate: string;
  /** Due date typed by the owner; used when there are no terms or `dueDateCustom` is on. */
  dueDate: string;
  /** `""` = no terms, else one of the allowed numbers of days. */
  /** `""` = no terms. */
  termsKind: "" | PaymentTermsKind;
  /** Days from the invoice date; used by the custom kind only. */
  termsDays: string;
  /** The due date is the typed one, not computed from the terms. */
  dueDateCustom: boolean;
  linkedInvoiceId: string;
  notes: string;
  lines: LineForm[];
  cassaType: string;
  cassaRate: string;
  cassaMode: "excluded" | "included";
  cassaSubjectToRitenuta: boolean;
  ritenutaType: string;
  ritenutaRate: string;
  ritenutaCausale: string;
  bollo: boolean;
  bolloDismissed: boolean;
  deferred: boolean;
  naturaTexts: Record<string, string>;
  paymentMethod: string;
  iban: string;
  bic: string;
  accountHolder: string;
  bankName: string;
}

let lineCounter = 0;
export const newLineKey = () => `line-${++lineCounter}`;

export function emptyLine(vat: string): LineForm {
  return { key: newLineKey(), description: "", quantity: "1", unit: "", price: "", vat };
}

export function emptyForm(): InvoiceForm {
  return {
    documentType: "TD01",
    clientId: "",
    currency: "EUR",
    requestedNumber: "",
    plannedDate: "",
    operationDate: "",
    dueDate: "",
    termsKind: "",
    termsDays: "",
    dueDateCustom: false,
    linkedInvoiceId: "",
    notes: "",
    lines: [emptyLine(`rate:${FALLBACK_VAT_BP}`)],
    cassaType: "",
    cassaRate: "",
    cassaMode: "excluded",
    cassaSubjectToRitenuta: false,
    ritenutaType: "",
    ritenutaRate: "",
    ritenutaCausale: "A",
    bollo: false,
    bolloDismissed: false,
    deferred: false,
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

/** The editor state of a stored invoice. */
export function fromRecord(record: InvoiceRecord): InvoiceForm {
  const { data } = record;
  return {
    documentType: record.documentType,
    clientId: record.clientId ?? "",
    currency: record.currency,
    requestedNumber: record.requestedNumber === null ? "" : String(record.requestedNumber),
    plannedDate: record.plannedDate ?? "",
    operationDate: record.operationDate ?? "",
    dueDate: record.dueDate ?? "",
    ...termsToForm(data.payment.terms),
    dueDateCustom: data.payment.dueDateCustom,
    linkedInvoiceId: record.linkedInvoiceId ?? "",
    notes: record.notes ?? "",
    lines: record.lines.map((line) => ({
      key: newLineKey(),
      description: line.description,
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
    ritenutaCausale: data.ritenuta?.causale ?? "A",
    bollo: data.bollo,
    bolloDismissed: data.bolloSuggestionDismissed,
    deferred: data.deferred,
    naturaTexts: Object.fromEntries(Object.entries(data.naturaTexts)) as Record<string, string>,
    paymentMethod: data.payment.method ?? "",
    iban: data.payment.iban ?? "",
    bic: data.payment.bic ?? "",
    accountHolder: data.payment.accountHolder ?? "",
    bankName: data.payment.bankName ?? "",
  };
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
 * The due date the invoice is saved with: computed from the terms (counted from the planned
 * issue date, else today) unless the owner set a date by hand or there are no terms.
 */
export function effectiveDueDate(form: InvoiceForm, today: string): string {
  const terms = formTerms(form);
  if (terms && !form.dueDateCustom) {
    const base = form.plannedDate.trim() || today;
    return isValidDate(base) ? computeDueDate(base, terms) : "";
  }
  return form.dueDate.trim();
}

/**
 * Prefills a new invoice from the client's defaults: VAT or
 * exemption on the lines, cassa/rivalsa, ritenuta, bollo, currency and payment terms. The bank
 * account is chosen separately (`withAccount`), so picking a client never overrides it.
 */
export function applyDefaults(form: InvoiceForm, client: ClientRecord | null): InvoiceForm {
  const next: InvoiceForm = { ...form };
  const defaults = client?.defaults;
  if (client) next.currency = client.currency;
  if (defaults) {
    const vat = defaults.natura
      ? `natura:${defaults.natura}`
      : defaults.vatRateBp
        ? `rate:${defaults.vatRateBp}`
        : null;
    if (vat) next.lines = form.lines.map((line) => ({ ...line, vat }));
    next.cassaType = defaults.cassa?.type ?? "";
    next.cassaRate = defaults.cassa ? bpToText(defaults.cassa.rateBp) : "";
    next.cassaMode = defaults.cassa?.mode ?? "excluded";
    next.cassaSubjectToRitenuta = defaults.cassa?.subjectToRitenuta ?? false;
    next.ritenutaType = defaults.ritenuta?.type ?? "";
    next.ritenutaRate = defaults.ritenuta ? bpToText(defaults.ritenuta.rateBp) : "";
    next.ritenutaCausale = defaults.ritenuta?.causale ?? "A";
    next.bollo = defaults.bollo;
  }
  // Terms prefill from the client default (none = no terms); the due date follows them.
  Object.assign(next, termsToForm(defaults?.terms));
  if (defaults?.terms) next.dueDateCustom = false;
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
          causale: form.ritenutaCausale as CausalePagamento,
        }
      : null,
    bollo: form.bollo,
    bolloSuggestionDismissed: form.bolloDismissed,
    deferred: form.deferred,
    naturaTexts: naturaTextsFor(form.lines, form.naturaTexts),
    payment: {
      terms: formTerms(form),
      dueDateCustom: form.dueDateCustom && formTerms(form) !== null,
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
      plannedDate: blank(form.plannedDate),
      operationDate: blank(form.operationDate),
      dueDate: blank(effectiveDueDate(form, today)),
      linkedInvoiceId: form.linkedInvoiceId || null,
      notes: blank(form.notes),
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
      unit: line.unit,
      quantityMilli: clean(line.quantityMilli),
      unitPriceCents: clean(line.unitPriceCents),
    })),
  });
}

function invoiceDataFor(input: InvoiceInput): InvoiceData {
  const clean = (n: number) => (Number.isFinite(n) ? n : 0);
  return {
    ...EMPTY_INVOICE_DATA,
    cassa: input.data.cassa
      ? { ...input.data.cassa, rateBp: clean(input.data.cassa.rateBp) }
      : null,
    ritenuta: input.data.ritenuta
      ? { ...input.data.ritenuta, rateBp: clean(input.data.ritenuta.rateBp) }
      : null,
    bollo: input.data.bollo,
    bolloSuggestionDismissed: input.data.bolloSuggestionDismissed,
    deferred: input.data.deferred,
  };
}

export { defaultCassaSubjectToRitenuta };
