import type { Bindings } from "../env";

/** Job name under which the daily run is recorded in `job_runs`. */
export const DAILY_JOB = "daily";

/** Rome date of the last successful daily run, for `shouldRunDaily`. */
export async function lastCompletedDailyDate(env: Bindings): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT MAX(run_date) AS run_date FROM job_runs WHERE job = ? AND status = 'success'",
  )
    .bind(DAILY_JOB)
    .first<{ run_date: string | null }>();
  return row?.run_date ?? null;
}

/** Job name under which each mailbox poll is recorded in `job_runs`. */
export const POLL_JOB = "poll";

export type JobCounts = Record<string, number | string | boolean>;

/** Records the start of a run; the returned id closes it with `finishJobRun`. */
export async function startJobRun(
  db: D1Database,
  job: string,
  runDate: string | null,
  now = Date.now(),
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO job_runs (id, job, run_date, started_at, status) VALUES (?, ?, ?, ?, 'running')",
    )
    .bind(id, job, runDate, now)
    .run();
  return id;
}

export async function finishJobRun(
  db: D1Database,
  id: string,
  result: { status: "success" | "failed"; counts?: JobCounts; errorCode?: string },
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      "UPDATE job_runs SET status = ?2, finished_at = ?3, counts = ?4, error_code = ?5 WHERE id = ?1",
    )
    .bind(
      id,
      result.status,
      now,
      result.counts ? JSON.stringify(result.counts) : null,
      result.errorCode ?? null,
    )
    .run();
}

/** When the last mailbox poll that completed successfully started (epoch ms), or null. */
export async function lastSuccessfulPollAt(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT MAX(started_at) AS at FROM job_runs WHERE job = ? AND status = 'success'")
    .bind(POLL_JOB)
    .first<{ at: number | null }>();
  return row?.at ?? null;
}
