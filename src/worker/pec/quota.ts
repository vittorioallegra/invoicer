import { romeDateTime } from "../../shared/cron";
import {
  DEFAULT_QUOTA_THRESHOLD_KB,
  ESTIMATED_MAILBOX_KB,
  isQuotaLow,
  kbToMb,
  type MailboxQuota,
  type MailboxStatus,
  type QuotaSource,
} from "../../shared/mailbox-quota";
import { type Bindings, missingSecrets } from "../env";
import { finishJobRun, lastFinishedRun, POLL_JOB, startJobRun } from "../jobs/job-runs";
import { notificationTitleKey } from "../outbox";
import { loadPecServers } from "./config";
import { ImapError, openMailbox } from "./imap";
import { pollDeps, pollErrorCode } from "./poll";

/** Job name under which each mailbox quota check is recorded in `job_runs`. */
export const QUOTA_JOB = "quota";

/** The configured free-space threshold in KiB (the default until the owner sets one). */
export async function loadThresholdKb(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT mail_quota_threshold_kb AS kb FROM settings WHERE id = 1")
    .first<{ kb: number | null }>();
  return row?.kb ?? DEFAULT_QUOTA_THRESHOLD_KB;
}

/** Usage estimated from the stored PEC messages, for a server that reports no quota. */
export async function estimatedUsedKb(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM pec_messages")
    .first<{ bytes: number }>();
  return Math.ceil((row?.bytes ?? 0) / 1024);
}

export type QuotaCheck =
  | { ok: true; usedKb: number; limitKb: number; source: QuotaSource; low: boolean }
  | { ok: false; errorCode: string };

/**
 * One mailbox quota check: logs in, asks `GETQUOTAROOT` (read-only) and falls back to an
 * estimate from the stored messages when the server has no QUOTA. The result is recorded as a
 * `job_runs` row of job `quota` (counts: used, limit, source). With `notify` (the daily job) a
 * low quota raises a `mailbox_quota_low` notification, unless an unread one is still waiting.
 * Returns null while the PEC secrets are unset; a failed login or connection is a failed run
 * (the poll raises the login warning), never an exception.
 */
export async function checkMailboxQuota(
  env: Bindings,
  options: { notify?: boolean; now?: Date } = {},
): Promise<QuotaCheck | null> {
  if (missingSecrets(env, "pec").length > 0) return null;
  const now = options.now ?? new Date();
  const runId = await startJobRun(env.DB, QUOTA_JOB, romeDateTime(now).date, now.getTime());
  try {
    const servers = await loadPecServers(env);
    const client = await openMailbox(pollDeps.open(servers.imapHost, servers.imapPort), {
      username: env.PEC_USERNAME as string,
      password: env.PEC_PASSWORD as string,
    }).catch((error: unknown) => {
      throw error instanceof ImapError ? error : new ImapError("closed", "Connection failed.");
    });
    let reported: Awaited<ReturnType<typeof client.getQuota>> = null;
    try {
      reported = await client.getQuota();
    } catch {
      // A server without QUOTA support answers BAD or drops the command: use the estimate.
    }
    await client.logout();
    const source: QuotaSource = reported ? "server" : "estimate";
    const usedKb = reported ? reported.usedKb : await estimatedUsedKb(env.DB);
    const limitKb = reported ? reported.limitKb : ESTIMATED_MAILBOX_KB;
    const thresholdKb = await loadThresholdKb(env.DB);
    const low = isQuotaLow(limitKb - usedKb, thresholdKb);
    await finishJobRun(
      env.DB,
      runId,
      { status: "success", counts: { usedKb, limitKb, source } },
      now.getTime(),
    );
    if (low && options.notify) {
      await notifyQuotaLow(env.DB, limitKb - usedKb, thresholdKb, now.getTime());
    }
    return { ok: true, usedKb, limitKb, source, low };
  } catch (error) {
    const errorCode = pollErrorCode(error);
    console.error("quota_check_failed", errorCode);
    await finishJobRun(env.DB, runId, { status: "failed", errorCode }, now.getTime());
    return { ok: false, errorCode };
  }
}

/** One notification until the owner reads it; the numbers change with every check. */
async function notifyQuotaLow(
  db: D1Database,
  freeKb: number,
  thresholdKb: number,
  now: number,
): Promise<void> {
  const type = "mailbox_quota_low";
  await db
    .prepare(
      `INSERT INTO notifications (id, type, title, body, invoice_id, created_at)
       SELECT ?1, ?2, ?3, ?4, NULL, ?5
       WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE type = ?2 AND read_at IS NULL)`,
    )
    .bind(
      crypto.randomUUID(),
      type,
      notificationTitleKey(type),
      JSON.stringify({ freeMb: kbToMb(freeKb), thresholdMb: kbToMb(thresholdKb) }),
      now,
    )
    .run();
}

/** Daily job: the quota check; 1 when it ran, 0 when it could not (no secrets, login refused). */
export async function dailyQuotaCheck(env: Bindings, now: Date): Promise<number> {
  const result = await checkMailboxQuota(env, { notify: true, now });
  return result?.ok ? 1 : 0;
}

/** The warnings behind the banners: a refused mailbox login and the last known quota. */
export async function loadMailboxStatus(db: D1Database): Promise<MailboxStatus> {
  const [poll, quotaRun, thresholdKb] = await Promise.all([
    lastFinishedRun(db, POLL_JOB),
    db
      .prepare(
        `SELECT started_at AS at, counts FROM job_runs
         WHERE job = ? AND status = 'success' ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .bind(QUOTA_JOB)
      .first<{ at: number; counts: string | null }>(),
    loadThresholdKb(db),
  ]);
  let quota: MailboxQuota | null = null;
  try {
    const counts = JSON.parse(quotaRun?.counts ?? "null") as {
      usedKb?: number;
      limitKb?: number;
      source?: QuotaSource;
    } | null;
    if (quotaRun && typeof counts?.usedKb === "number" && typeof counts.limitKb === "number") {
      const freeKb = counts.limitKb - counts.usedKb;
      quota = {
        usedKb: counts.usedKb,
        limitKb: counts.limitKb,
        freeKb,
        source: counts.source === "server" ? "server" : "estimate",
        checkedAt: quotaRun.at,
        low: isQuotaLow(freeKb, thresholdKb),
      };
    }
  } catch {
    // An unreadable record counts as no check yet.
  }
  return {
    loginFailing: poll?.errorCode === "login_failed" ? { at: poll.at } : null,
    quota,
    thresholdKb,
  };
}
