/**
 * Cron triggers (wrangler.jsonc `triggers.crons`); at most 3 (the free plan allows 5 per
 * account). One `scheduled` handler dispatches on the cron expression. Cloudflare day-of-week
 * syntax: use `SUN`, not `0`.
 */
export const CRON = {
  /** PEC mailbox polling (step 13). */
  poll: "*/10 * * * *",
  daily: "0 4 * * *",
  weekly: "0 3 * * SUN",
} as const;

export type CronJob = "poll" | "daily" | "weekly";

export function jobForCron(cron: string): CronJob | null {
  if (cron === CRON.poll) return "poll";
  if (cron === CRON.daily) return "daily";
  if (cron === CRON.weekly) return "weekly";
  return null;
}
