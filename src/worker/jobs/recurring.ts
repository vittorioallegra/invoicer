import { romeDateTime } from "../../shared/cron";
import type { InvoiceBody } from "../../shared/invoice";
import { dueDate } from "../../shared/payment-terms";
import { addDays, scheduleDates } from "../../shared/recurring";
import type { Bindings } from "../env";
import { createRecurringInvoice } from "../invoices/store";
import {
  loadLeadDays,
  readBody,
  scheduleOf,
  TEMPLATE_SELECT,
  type TemplateRow,
} from "../recurring";

/** Most invoices one daily run creates; a larger backlog (long downtime) continues the next day. */
export const RECURRING_MAX_PER_RUN = 50;

/** Dates of one template that are due and not recorded yet, in order, within its limits. */
async function dueDates(
  db: D1Database,
  row: TemplateRow,
  upToBase: string,
  room: number,
): Promise<string[]> {
  const schedule = scheduleOf(row);
  const upTo = schedule.endDate && schedule.endDate < upToBase ? schedule.endDate : upToBase;
  const dates = scheduleDates(schedule, upTo);
  if (dates.length === 0) return [];
  const { results } = await db
    .prepare(
      "SELECT occurrence_date AS date, invoice_id AS invoiceId FROM recurring_occurrences WHERE template_id = ?",
    )
    .bind(row.id)
    .all<{ date: string; invoiceId: string | null }>();
  const recorded = new Set(results.map((occurrence) => occurrence.date));
  // The limit counts the invoices that exist; one the owner deleted frees its place.
  const created = results.filter((occurrence) => occurrence.invoiceId !== null).length;
  const remaining = schedule.maxCount === null ? room : Math.min(room, schedule.maxCount - created);
  return dates.filter((date) => !recorded.has(date)).slice(0, Math.max(0, remaining));
}

/**
 * Daily job: creates the invoice of every recurring occurrence that falls within the lead time
 * (`recurring_lead_days`, default 3 days ahead of its date), exactly once per template and date:
 * the batch of `createRecurringInvoice` is conditional on the occurrence not being recorded, so a
 * second run on the same day, a retry after a crash and a catch-up after downtime never duplicate
 * an invoice. Each is a normal unsent invoice ("To send") with a notification; nothing is ever
 * sent. Paused templates are skipped. Returns how many invoices were created.
 */
export async function createRecurringInvoices(env: Bindings, now = new Date()): Promise<number> {
  const today = romeDateTime(now).date;
  const upToBase = addDays(today, await loadLeadDays(env.DB));
  const { results: templates } = await env.DB.prepare(
    `${TEMPLATE_SELECT} WHERE t.paused = 0 AND t.start_date <= ?1 ORDER BY t.created_at, t.id`,
  )
    .bind(upToBase)
    .all<TemplateRow>();
  let created = 0;
  for (const row of templates) {
    const room = RECURRING_MAX_PER_RUN - created;
    if (room <= 0) break;
    const content = readBody(row);
    if (!content) {
      console.error("recurring_template_unreadable", row.id);
      continue;
    }
    for (const date of await dueDates(env.DB, row, upToBase, room)) {
      const body: InvoiceBody = {
        documentType: "TD01",
        clientId: row.client_id,
        currency: content.currency,
        requestedNumber: null,
        seriesId: content.seriesId,
        invoiceDate: date,
        dueDate: content.data.payment.terms ? dueDate(date, content.data.payment.terms) : null,
        linkedInvoiceId: null,
        lines: content.lines,
        data: content.data,
      };
      const id = await createRecurringInvoice(
        env.DB,
        { templateId: row.id, date, clientName: row.client_name ?? "" },
        body,
        now,
      );
      if (id) created += 1;
    }
  }
  return created;
}
