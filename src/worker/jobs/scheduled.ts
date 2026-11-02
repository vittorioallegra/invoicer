import type { Bindings } from "../env";

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

/** Jobs are registered by later steps (mailbox polling, daily jobs, backup). */
const handlers: Record<CronJob, Array<(env: Bindings) => Promise<void>>> = {
  poll: [],
  daily: [],
  weekly: [],
};

export async function runScheduled(event: ScheduledController, env: Bindings): Promise<void> {
  const job = jobForCron(event.cron);
  if (!job) {
    console.error("scheduled_unknown_cron", event.cron);
    return;
  }
  for (const handler of handlers[job]) await handler(env);
}
