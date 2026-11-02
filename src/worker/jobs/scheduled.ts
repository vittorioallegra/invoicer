import { type CronJob, jobForCron } from "../../shared/cron";
import type { Bindings } from "../env";

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
