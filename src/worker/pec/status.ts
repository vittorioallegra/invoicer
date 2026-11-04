import type { MailboxStatus } from "../../shared/mailbox-status";
import { lastFinishedRun, POLL_JOB } from "../jobs/job-runs";

/** The warning behind the banner: whether the latest finished poll was refused at login. */
export async function loadMailboxStatus(db: D1Database): Promise<MailboxStatus> {
  const poll = await lastFinishedRun(db, POLL_JOB);
  return { loginFailing: poll?.errorCode === "login_failed" ? { at: poll.at } : null };
}
