import { Hono } from "hono";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";
import { DAILY_JOB, lastFinishedRun, POLL_JOB } from "../jobs/job-runs";

export const jobs = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

/** The last mailbox poll and the last daily run, from `job_runs` (shown in Settings). */
jobs.get("/", async (c) => {
  const [poll, daily] = await Promise.all([
    lastFinishedRun(c.env.DB, POLL_JOB),
    lastFinishedRun(c.env.DB, DAILY_JOB),
  ]);
  return c.json({ poll, daily });
});
