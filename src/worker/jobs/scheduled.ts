import { jobForCron, romeDateTime, shouldRunDaily } from "../../shared/cron";
import type { Bindings } from "../env";
import { pollMailbox } from "../pec/poll";
import { remindUnsentInvoices } from "./invoice-due";
import { DAILY_JOB, finishJobRun, startJobRun } from "./job-runs";

type Handler = (env: Bindings) => Promise<void>;

/** Mailbox polling runs on every tick; the daily jobs run once per Rome day from 09:00. */
export const handlers: { poll: Handler[]; daily: Handler[] } = {
  poll: [async (env) => void (await pollMailbox(env))],
  daily: [async (env) => void (await remindUnsentInvoices(env))],
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
  const runDate = romeDateTime(now).date;
  console.log("scheduled_daily_due", runDate);
  // Recorded so the next ticks of the day skip it; a failed run is retried by the next tick.
  const run = await startJobRun(env.DB, DAILY_JOB, runDate);
  try {
    for (const handler of handlers.daily) await handler(env);
    await finishJobRun(env.DB, run, { status: "success" });
  } catch (error) {
    console.error("scheduled_daily_failed", error instanceof Error ? error.name : "error");
    await finishJobRun(env.DB, run, { status: "failed", errorCode: "daily_failed" });
  }
}
