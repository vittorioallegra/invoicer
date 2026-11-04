import enEmail from "../../locales/en/email.json";
import itEmail from "../../locales/it/email.json";
import { formatDate, formatMoney } from "./format";
import type { InvoiceLanguage } from "./invoice";

const TEMPLATES = { en: enEmail.courtesy, it: itEmail.courtesy } as const;

export interface CourtesyEmailParams {
  client: string;
  sender: string;
  number: string;
  /** Issue date, `YYYY-MM-DD`. */
  date: string;
  /** Due date, `YYYY-MM-DD`; omitted lines are left out of the body. */
  dueDate: string | null;
  totalCents: number;
  currency: string;
  creditNote: boolean;
  /** The SdI could not deliver the invoice: the email points the client to their AdE area. */
  notDelivered: boolean;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}

/**
 * Subject and plain-text body of the courtesy email in the invoice's language. Templates are the
 * `courtesy` keys of `locales/{en,it}/email.json`; the Worker has no i18n library, so the
 * `{{name}}` placeholders are filled here. The owner can edit both before an "ask" or manual send.
 */
export function renderCourtesyEmail(
  language: InvoiceLanguage,
  p: CourtesyEmailParams,
): { subject: string; body: string } {
  const tpl = TEMPLATES[language];
  const values: Record<string, string> = {
    client: p.client,
    sender: p.sender,
    number: p.number,
    date: formatDate(p.date, language),
    total: formatMoney(p.totalCents, language, p.currency),
    due: "",
    notDelivered: p.notDelivered ? tpl.notDelivered : "",
  };
  if (p.dueDate && !p.creditNote) {
    values.due = fill(tpl.due, { dueDate: formatDate(p.dueDate, language) });
  }
  return {
    subject: fill(p.creditNote ? tpl.subjectCreditNote : tpl.subject, values),
    body: fill(p.creditNote ? tpl.bodyCreditNote : tpl.body, values),
  };
}
