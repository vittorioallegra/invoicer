import { z } from "zod";
import { invoiceInputSchema, isValidDate } from "./invoice";

/** How often a template repeats, in months: monthly, every 2, quarterly, every 4, half-yearly, yearly. */
export const RECURRING_INTERVALS = [1, 2, 3, 4, 6, 12] as const;

/** Days ahead of an occurrence's date on which its invoice is created (default and bounds). */
export const DEFAULT_RECURRING_LEAD_DAYS = 3;
export const MAX_RECURRING_LEAD_DAYS = 30;

/** Largest number of invoices a template may be limited to. */
export const MAX_RECURRING_COUNT = 1200;

const dateOnly = z.string().refine(isValidDate, "invalid_date");

/** When a template repeats: every N months on a day of the month, from a start date. */
export const recurringScheduleSchema = z
  .object({
    intervalMonths: z
      .number()
      .refine((n) => (RECURRING_INTERVALS as readonly number[]).includes(n)),
    /** 1-31; a shorter month uses its last day. */
    dayOfMonth: z.number().int().min(1).max(31),
    startDate: dateOnly,
    endDate: dateOnly.nullable(),
    maxCount: z.number().int().min(1).max(MAX_RECURRING_COUNT).nullable(),
  })
  .refine((schedule) => schedule.endDate === null || schedule.endDate >= schedule.startDate, {
    message: "end_before_start",
    path: ["endDate"],
  });
export type RecurringSchedule = z.output<typeof recurringScheduleSchema>;

/**
 * What a template copies into each invoice: the invoice settings and lines (never the date, the
 * number, the due date or a linked invoice; the client is the template's own).
 */
export const recurringBodySchema = invoiceInputSchema.pick({
  currency: true,
  seriesId: true,
  lines: true,
  data: true,
});
export type RecurringBody = z.output<typeof recurringBodySchema>;

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` shifted by whole days (calendar arithmetic, no time zone involved). */
export function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The dates of a schedule from its start date up to and including `upTo`, ascending, at most
 * `limit` of them. Month `k` is the start month plus `k` intervals; the day is the day of month
 * (the month's last day when it is shorter). A first date before the start date is skipped, so
 * a template starting on the 20th with day 15 first fires next month (or next interval).
 */
export function scheduleDates(
  schedule: Pick<RecurringSchedule, "intervalMonths" | "dayOfMonth" | "startDate">,
  upTo: string,
  limit = Number.POSITIVE_INFINITY,
): string[] {
  const out: string[] = [];
  const [startYear, startMonth] = schedule.startDate.split("-").map(Number) as [number, number];
  // A bounded loop: a century of monthly dates is far beyond any template.
  for (let k = 0; k < 1200 && out.length < limit; k += 1) {
    const monthIndex = startYear * 12 + (startMonth - 1) + k * schedule.intervalMonths;
    const year = Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const date = `${year}-${pad(month)}-${pad(Math.min(schedule.dayOfMonth, lastDay))}`;
    if (date > upTo) break;
    if (date >= schedule.startDate) out.push(date);
  }
  return out;
}

/** A template as the Recurring page lists it. */
export interface RecurringTemplateRecord extends RecurringSchedule {
  id: string;
  clientId: string;
  clientName: string | null;
  paused: boolean;
  /** Number of lines and the total of the copied invoice, in the template's currency. */
  lineCount: number;
  totalCents: number | null;
  currency: string;
  /** Invoices created so far, and the date of the latest occurrence handled. */
  createdCount: number;
  /** The next date an invoice is due to be created for, or null when the template is finished. */
  nextDate: string | null;
}

export interface RecurringList {
  templates: RecurringTemplateRecord[];
  leadDays: number;
}
