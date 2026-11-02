import { jobForCron, romeDateTime, shouldRunDaily } from "../../shared/cron";
import type { Bindings } from "../env";

type Handler = (env: Bindings) => Promise<void>;

/** Jobs are registered by later steps (mailbox polling, daily jobs). */
export const handlers: { poll: Handler[]; daily: Handler[] } = {
  poll: [],
  daily: [],
};

/** Rome date of the last completed daily run; backed by `job_runs` from step 3 on. */
export type LastDailyLookup = (env: Bindings) => Promise<string | null>;

const noRecordedRun: LastDailyLookup = async () => null;

export async function runScheduled(
  event: ScheduledController,
  env: Bindings,
  lastDaily: LastDailyLookup = noRecordedRun,
): Promise<void> {
  if (!jobForCron(event.cron)) {
    console.error("scheduled_unknown_cron", event.cron);
    return;
  }
  for (const handler of handlers.poll) await handler(env);

  const now = new Date(event.scheduledTime);
  if (!shouldRunDaily(now, await lastDaily(env))) return;
  console.log("scheduled_daily_due", romeDateTime(now).date);
  for (const handler of handlers.daily) await handler(env);
}
