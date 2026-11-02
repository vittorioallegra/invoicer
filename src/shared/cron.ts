/**
 * Cron triggers (wrangler.jsonc `triggers.crons`): a single every-10-minutes trigger. Every run
 * polls the mailbox; the daily jobs piggyback on it (see `shouldRunDaily`).
 */
export const CRON = {
  /** PEC mailbox polling (step 13) and daily-job gate. */
  poll: "*/10 * * * *",
} as const;

export type CronJob = "poll";

export function jobForCron(cron: string): CronJob | null {
  return cron === CRON.poll ? "poll" : null;
}

export const DAILY_TIME_ZONE = "Europe/Rome";
/** Local hour (Europe/Rome) from which the daily jobs may run. */
export const DAILY_HOUR = 9;

const romeParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: DAILY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

/** Europe/Rome calendar date (`YYYY-MM-DD`) and hour of an instant; DST handled by Intl. */
export function romeDateTime(at: Date): { date: string; hour: number } {
  const parts: Record<string, string> = {};
  for (const p of romeParts.formatToParts(at)) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/**
 * Whether the daily jobs are due: Rome local time is 09:00 or later and the daily run of the
 * current Rome date has not completed yet. A missed tick is caught up by the next one.
 */
export function shouldRunDaily(nowUtc: Date, lastCompletedRomeDate: string | null): boolean {
  const { date, hour } = romeDateTime(nowUtc);
  return hour >= DAILY_HOUR && lastCompletedRomeDate !== date;
}
