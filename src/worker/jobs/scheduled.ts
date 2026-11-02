import type { Bindings } from "../env";

/**
 * Cron triggers (wrangler.jsonc `triggers.crons`); at most 2 (the free plan allows 5 per
 * account). One `scheduled` handler dispatches on the cron expression.
 */
export const CRON = {
  daily: "0 4 * * *",
  weekly: "0 3 * * SUN",
} as const;

export type CronJob = "daily" | "weekly";

export function jobForCron(cron: string): CronJob | null {
  if (cron === CRON.daily) return "daily";
  if (cron === CRON.weekly) return "weekly";
  return null;
}

/** Jobs are registered by later steps (reconciliation, recurring, backup). */
const handlers: Record<CronJob, Array<(env: Bindings) => Promise<void>>> = {
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
