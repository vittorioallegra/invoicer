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

/**
 * When the last mailbox poll that completed successfully and drained the mailbox started (epoch
 * ms), or null. A run stopped by its per-run caps (`counts.more`) left newer mail unread, which
 * may hold the receipt of an unknown send, so it does not count.
 */
export async function lastSuccessfulPollAt(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MAX(started_at) AS at FROM job_runs WHERE job = ? AND status = 'success'
         AND COALESCE(json_extract(counts, '$.more'), 0) = 0`,
    )
    .bind(POLL_JOB)
    .first<{ at: number | null }>();
  return row?.at ?? null;
}

export interface LastRun {
  /** When the run started (epoch ms). */
  at: number;
  /** Europe/Rome date the run belongs to. */
  runDate: string | null;
  status: "success" | "failed";
  errorCode: string | null;
  counts: JobCounts | null;
}

/** The most recent finished run of a job, or null when it never ran. */
export async function lastFinishedRun(db: D1Database, job: string): Promise<LastRun | null> {
  const row = await db
    .prepare(
      `SELECT started_at AS at, run_date AS runDate, status, error_code AS errorCode, counts
       FROM job_runs WHERE job = ? AND status IN ('success', 'failed')
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(job)
    .first<{
      at: number;
      runDate: string | null;
      status: "success" | "failed";
      errorCode: string | null;
      counts: string | null;
    }>();
  if (!row) return null;
  let counts: JobCounts | null = null;
  try {
    counts = row.counts ? (JSON.parse(row.counts) as JobCounts) : null;
  } catch {
    // Unreadable counts: the run is still listed.
  }
  return { ...row, counts };
}
