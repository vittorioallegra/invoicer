import { jobForCron, romeDateTime, shouldRunDaily } from "../../shared/cron";
import type { Bindings } from "../env";
import { pollMailbox } from "../pec/poll";
import { processPushNotifications } from "../push/deliver";
import { remindUnsentInvoices } from "./invoice-due";
import { notifyOverdueInvoices } from "./invoice-overdue";
import { DAILY_JOB, finishJobRun, type JobCounts, startJobRun } from "./job-runs";
import { createRecurringInvoices } from "./recurring";

type Handler = (env: Bindings) => Promise<void>;

/** Pushes the notifications the poll or a daily job just wrote; a failure waits for the next tick. */
async function pushNotifications(env: Bindings): Promise<void> {
  try {
    await processPushNotifications(env);
  } catch {
    console.error("push_failed");
  }
}

/** One daily job: returns how many things it did (notifications, invoices created...). */
export interface DailyTask {
  name: string;
  run: (env: Bindings, now: Date) => Promise<number>;
}

/** The daily jobs, in order. Each is idempotent: a run that is repeated writes nothing twice. */
export const dailyTasks: DailyTask[] = [
  { name: "unsent", run: remindUnsentInvoices },
  { name: "overdue", run: notifyOverdueInvoices },
  { name: "recurring", run: createRecurringInvoices },
];

/**
 * Runs every daily task, each on its own so one failure does not stop the others; the counts
 * say what each did (`-1` = it failed). Returns whether all of them succeeded.
 */
export async function runDailyTasks(
  env: Bindings,
  now: Date,
  tasks: DailyTask[] = dailyTasks,
): Promise<{ ok: boolean; counts: JobCounts }> {
  const counts: JobCounts = {};
  let ok = true;
  for (const task of tasks) {
    try {
      counts[task.name] = await task.run(env, now);
    } catch (error) {
      console.error("daily_task_failed", task.name, error instanceof Error ? error.name : "error");
      counts[task.name] = -1;
      ok = false;
    }
  }
  return { ok, counts };
}

/**
 * Mailbox polling runs on every tick, then the pushes of whatever it wrote; the daily jobs run
 * once per Rome day from 09:00 (`runDailyTasks`), followed by their pushes.
 */
export const handlers: { poll: Handler[] } = {
  poll: [async (env) => void (await pollMailbox(env)), pushNotifications],
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
    const { ok, counts } = await runDailyTasks(env, now);
    await pushNotifications(env);
    await finishJobRun(
      env.DB,
      run,
      ok ? { status: "success", counts } : { status: "failed", counts, errorCode: "daily_failed" },
    );
  } catch (error) {
    console.error("scheduled_daily_failed", error instanceof Error ? error.name : "error");
    await finishJobRun(env.DB, run, { status: "failed", errorCode: "daily_failed" });
  }
}
