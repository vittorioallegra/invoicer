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
