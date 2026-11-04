import { romeDateTime } from "../shared/cron";
import { safeTotals } from "../shared/invoice";
import {
  addDays,
  DEFAULT_RECURRING_LEAD_DAYS,
  type RecurringBody,
  type RecurringSchedule,
  type RecurringTemplateRecord,
  recurringBodySchema,
  scheduleDates,
} from "../shared/recurring";
import { loadInvoice } from "./invoices/store";
import { makeError } from "./problem";

export interface TemplateRow {
  id: string;
  client_id: string;
  client_name: string | null;
  body: string;
  interval_months: number;
  day_of_month: number;
  start_date: string;
  end_date: string | null;
  max_count: number | null;
  paused: number;
}

export const TEMPLATE_SELECT = `SELECT t.id, t.client_id, c.name AS client_name, t.body, t.interval_months,
  t.day_of_month, t.start_date, t.end_date, t.max_count, t.paused
  FROM recurring_templates t LEFT JOIN clients c ON c.id = t.client_id`;

export const scheduleOf = (row: TemplateRow): RecurringSchedule => ({
  intervalMonths: row.interval_months,
  dayOfMonth: row.day_of_month,
  startDate: row.start_date,
  endDate: row.end_date,
  maxCount: row.max_count,
});

/** The copied invoice content of a template, or null when the stored JSON is not readable. */
export function readBody(row: TemplateRow): RecurringBody | null {
  try {
    const parsed = recurringBodySchema.safeParse(JSON.parse(row.body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Days ahead of an occurrence on which its invoice is created (Settings value, default 3). */
export async function loadLeadDays(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT recurring_lead_days AS days FROM settings WHERE id = 1")
    .first<{ days: number | null }>();
  return row?.days ?? DEFAULT_RECURRING_LEAD_DAYS;
}

export async function saveLeadDays(db: D1Database, days: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (id, recurring_lead_days, updated_at) VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET recurring_lead_days = ?1, updated_at = ?2`,
    )
    .bind(days, Date.now())
    .run();
}

/**
 * Records the schedule's dates before `today` that have no occurrence yet as skipped (an
 * occurrence without an invoice), so they are never created. A new template, a resumed one and an
 * edited schedule all start from today on; only a job that missed days (downtime) catches up.
 * Insert-or-ignore, so it is safe to repeat.
 */
export async function skipPastOccurrences(
  db: D1Database,
  templateId: string,
  schedule: RecurringSchedule,
  today: string,
  now = Date.now(),
): Promise<void> {
  const past = scheduleDates(schedule, addDays(today, -1));
  const CHUNK = 20;
  for (let from = 0; from < past.length; from += CHUNK) {
    const dates = past.slice(from, from + CHUNK);
    await db
      .prepare(
        `INSERT OR IGNORE INTO recurring_occurrences (id, template_id, occurrence_date, invoice_id, created_at)
         VALUES ${dates.map(() => "(?, ?, ?, NULL, ?)").join(", ")}`,
      )
      .bind(...dates.flatMap((date) => [crypto.randomUUID(), templateId, date, now]))
      .run();
  }
}

/**
 * Creates a template from an existing invoice: its client and a copy of its settings and lines.
 * Credit notes, imported invoices and invoices without a client cannot repeat.
 */
export async function createTemplateFromInvoice(
  db: D1Database,
  invoiceId: string,
  schedule: RecurringSchedule,
  now = new Date(),
): Promise<string> {
  const record = await loadInvoice(db, invoiceId, now);
  if (!record) throw makeError("not_found");
  if (record.source !== "app" || record.documentType !== "TD01") {
    throw makeError("bad_request", "invoice_not_repeatable");
  }
  if (!record.clientId) throw makeError("bad_request", "client_missing");
  const body: RecurringBody = {
    currency: record.currency,
    seriesId: record.seriesId,
    lines: record.lines,
    // A new invoice follows the current bollo rule, never the stored "legacy" one.
    data: {
      ...record.data,
      bolloCharge: record.data.bolloCharge === "legacy" ? "client" : record.data.bolloCharge,
    },
  };
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO recurring_templates
         (id, client_id, body, interval_months, day_of_month, start_date, end_date, max_count, paused, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(
      id,
      record.clientId,
      JSON.stringify(body),
      schedule.intervalMonths,
      schedule.dayOfMonth,
      schedule.startDate,
      schedule.endDate,
      schedule.maxCount,
      now.getTime(),
    )
    .run();
  await skipPastOccurrences(db, id, schedule, romeDateTime(now).date, now.getTime());
  return id;
}

/** Templates with their client, totals and progress, newest first. */
export async function listTemplates(
  db: D1Database,
  now = new Date(),
): Promise<RecurringTemplateRecord[]> {
  const today = romeDateTime(now).date;
  const { results } = await db
    .prepare(`${TEMPLATE_SELECT} ORDER BY t.created_at DESC, t.id`)
    .all<TemplateRow>();
  const { results: occurrences } = await db
    .prepare(
      "SELECT template_id AS templateId, occurrence_date AS date, invoice_id AS invoiceId FROM recurring_occurrences",
    )
    .all<{ templateId: string; date: string; invoiceId: string | null }>();
  const recorded = new Map<string, Set<string>>();
  const created = new Map<string, number>();
  for (const row of occurrences) {
    if (!recorded.has(row.templateId)) recorded.set(row.templateId, new Set());
    recorded.get(row.templateId)?.add(row.date);
    if (row.invoiceId) created.set(row.templateId, (created.get(row.templateId) ?? 0) + 1);
  }
  return results.map((row) => {
    const schedule = scheduleOf(row);
    const body = readBody(row);
    const createdCount = created.get(row.id) ?? 0;
    const finished = schedule.maxCount !== null && createdCount >= schedule.maxCount;
    const upTo =
      schedule.endDate ??
      addDays(schedule.startDate.localeCompare(today) > 0 ? schedule.startDate : today, 3650);
    const next = finished
      ? undefined
      : scheduleDates(schedule, upTo).find(
          (date) => date >= today && !recorded.get(row.id)?.has(date),
        );
    const totals = body
      ? safeTotals({
          documentType: "TD01",
          currency: body.currency,
          lines: body.lines,
          data: body.data,
        })
      : null;
    return {
      id: row.id,
      clientId: row.client_id,
      clientName: row.client_name,
      ...schedule,
      paused: row.paused === 1,
      lineCount: body?.lines.length ?? 0,
      totalCents: totals?.documentTotalCents ?? null,
      currency: body?.currency ?? "EUR",
      createdCount,
      nextDate: next ?? null,
    };
  });
}

export async function loadTemplate(db: D1Database, id: string): Promise<TemplateRow> {
  const row = await db.prepare(`${TEMPLATE_SELECT} WHERE t.id = ?`).bind(id).first<TemplateRow>();
  if (!row) throw makeError("not_found");
  return row;
}

/** Editing a template changes future occurrences only; dates already behind it are skipped. */
export async function updateTemplateSchedule(
  db: D1Database,
  id: string,
  schedule: RecurringSchedule,
  now = new Date(),
): Promise<void> {
  await loadTemplate(db, id);
  await db
    .prepare(
      `UPDATE recurring_templates SET interval_months = ?2, day_of_month = ?3, start_date = ?4,
         end_date = ?5, max_count = ?6 WHERE id = ?1`,
    )
    .bind(
      id,
      schedule.intervalMonths,
      schedule.dayOfMonth,
      schedule.startDate,
      schedule.endDate,
      schedule.maxCount,
    )
    .run();
  await skipPastOccurrences(db, id, schedule, romeDateTime(now).date, now.getTime());
}

/** Pausing creates nothing; resuming starts from today (the paused dates are not made up). */
export async function setTemplatePaused(
  db: D1Database,
  id: string,
  paused: boolean,
  now = new Date(),
): Promise<void> {
  const row = await loadTemplate(db, id);
  await db
    .prepare("UPDATE recurring_templates SET paused = ?2 WHERE id = ?1")
    .bind(id, paused ? 1 : 0)
    .run();
  if (!paused) {
    await skipPastOccurrences(db, id, scheduleOf(row), romeDateTime(now).date, now.getTime());
  }
}

/** Deletes the template and its occurrence records; the invoices already created stay. */
export async function deleteTemplate(db: D1Database, id: string): Promise<void> {
  await loadTemplate(db, id);
  await db.batch([
    db
      .prepare("UPDATE invoices SET recurring_template_id = NULL WHERE recurring_template_id = ?")
      .bind(id),
    db.prepare("DELETE FROM recurring_occurrences WHERE template_id = ?").bind(id),
    db.prepare("DELETE FROM recurring_templates WHERE id = ?").bind(id),
  ]);
}
