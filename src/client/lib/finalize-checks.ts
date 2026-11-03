import type { TFunction } from "i18next";

/** One reason an invoice cannot be finalised yet, with where to fix it. */
export interface FinalizeProblem {
  key: string;
  label: string;
  message?: string;
  /** Data path of the editor field to focus (`lines.0.vat`), see `focusField`. */
  field?: string;
  /** A settings page to open instead, for problems outside the invoice. */
  to?: "/settings/profile";
}

const LINE_FIELDS: Record<string, string> = {
  description: "invoice.lines.description",
  quantityMilli: "invoice.lines.quantity",
  unit: "invoice.lines.unit",
  unitPriceCents: "invoice.lines.price",
  vat: "invoice.lines.vat",
  natura: "invoice.lines.vat",
  note: "invoice.lines.noteOptional",
};

const FIELD_LABELS: Record<string, string> = {
  clientId: "invoice.client.label",
  currency: "invoice.document.currency",
  requestedNumber: "invoice.document.number",
  invoiceDate: "invoice.document.invoiceDate",
  dueDate: "invoice.document.dueDate",
  linkedInvoiceId: "invoice.document.linked",
  lines: "invoice.lines.title",
  "data.note": "invoice.document.note",
  "data.cassa.type": "clients.form.cassa",
  "data.cassa.rateBp": "clients.form.cassaRate",
  "data.ritenuta.type": "clients.form.ritenuta",
  "data.ritenuta.rateBp": "clients.form.ritenutaRate",
  "data.ritenuta.baseBp": "clients.form.ritenutaBase",
  "data.ritenuta.causale": "clients.form.ritenutaCausale",
  "data.payment.method": "invoice.payment.method",
  "data.payment.iban": "invoice.payment.account",
  "data.payment.bic": "invoice.payment.account",
  "data.payment.terms.kind": "paymentTerms.label",
  "data.payment.terms.days": "paymentTerms.days",
};

/** Position of a field in the form, so the problems read top to bottom. */
const ORDER = [
  "clientId",
  "client.",
  "currency",
  "requestedNumber",
  "invoiceDate",
  "linkedInvoiceId",
  "data.cassa",
  "data.ritenuta",
  "lines",
  "data.naturaTexts",
  "data.note",
  "data.payment",
  "dueDate",
];

function rank(path: string): [number, number] {
  const group = ORDER.findIndex((prefix) => path === prefix || path.startsWith(prefix));
  const line = /^lines\.(\d+)\./.exec(path)?.[1];
  return [group === -1 ? ORDER.length : group, line === undefined ? -1 : Number(line)];
}

function labelOf(t: TFunction, path: string): { label: string; field: string } {
  if (path.startsWith("client.")) {
    const part = path.slice("client.".length).split(".")[0] ?? "";
    return {
      label: `${t("invoice.client.label")}: ${t(`clients.form.${part}`, { defaultValue: part })}`,
      field: "clientId",
    };
  }
  const line = /^lines\.(\d+)\.(\w+)$/.exec(path);
  if (line) {
    const n = Number(line[1]) + 1;
    return {
      label: `${t("invoice.lines.lineNumber", { n })}: ${t(LINE_FIELDS[line[2] ?? ""] ?? "invoice.lines.title")}`,
      field: path,
    };
  }
  const natura = /^data\.naturaTexts\.(.+)$/.exec(path);
  if (natura) return { label: t("invoice.natura.label", { code: natura[1] }), field: path };
  const key = FIELD_LABELS[path];
  return { label: key ? t(key) : path, field: path };
}

/**
 * The checks of Finalize in one list, from what the editor already computes: the form problems
 * (`validateForm` with the issuing rules, which cover the client, VAT on every line, natura
 * texts and the number rules) and the conditions outside the form (connection, company details).
 * The XSD check of the built XML follows in the send flow, once the invoice is saved.
 */
export function finalizeProblems(
  t: TFunction,
  input: {
    errors: Record<string, string>;
    nextNumber: number | null;
    online: boolean;
    profileIncomplete: boolean;
  },
): FinalizeProblem[] {
  const out: FinalizeProblem[] = [];
  if (!input.online) out.push({ key: "offline", label: t("offline.reason") });
  if (input.profileIncomplete) {
    out.push({
      key: "profile",
      label: t("onboarding.reasons.profile_incomplete"),
      to: "/settings/profile",
    });
  }
  const paths = Object.keys(input.errors).sort((a, b) => {
    const [ga, la] = rank(a);
    const [gb, lb] = rank(b);
    return ga - gb || la - lb || a.localeCompare(b);
  });
  for (const path of paths) {
    const code = input.errors[path] ?? "invalid";
    const { label, field } = labelOf(t, path);
    const message =
      code === "number_too_low"
        ? t("invoice.document.numberTooLow", { next: input.nextNumber ?? "" })
        : t(`validation.${code}`, { defaultValue: t("validation.invalid") });
    out.push({ key: path, label, message, field });
  }
  return out;
}

/**
 * Moves the focus to the editor field of a path (the control inside the element marked
 * `data-field`), falling back to the first field showing an error.
 */
export function focusField(root: ParentNode, path: string): void {
  const marked = root.querySelector(`[data-field="${CSS.escape(path)}"]`);
  const target =
    marked?.querySelector<HTMLElement>("input, select, textarea, button") ??
    root.querySelector<HTMLElement>('[aria-invalid="true"]');
  target?.focus();
  target?.scrollIntoView?.({ block: "center" });
}
