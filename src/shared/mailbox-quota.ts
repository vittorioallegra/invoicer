/** Free space below which the quota warning shows (KiB): 50 MB, until the owner sets another. */
export const DEFAULT_QUOTA_THRESHOLD_KB = 50 * 1024;

/** Largest threshold the owner may set (MB); a PEC mailbox is about 1 GB. */
export const MAX_QUOTA_THRESHOLD_MB = 1000;

/**
 * Mailbox size assumed when the server reports no quota (KiB): the 1,024,000 KiB the Aruba PEC
 * mailbox reported in the step 2 probe (docs/notes/spike.md).
 */
export const ESTIMATED_MAILBOX_KB = 1_024_000;

/** Where the usage numbers come from: the server's `GETQUOTAROOT`, or the stored messages' sizes. */
export type QuotaSource = "server" | "estimate";

export interface MailboxQuota {
  usedKb: number;
  limitKb: number;
  freeKb: number;
  source: QuotaSource;
  /** When the check ran (epoch ms). */
  checkedAt: number;
  /** Free space is below the threshold. */
  low: boolean;
}

export function isQuotaLow(freeKb: number, thresholdKb: number): boolean {
  return freeKb < thresholdKb;
}

/** Whole megabytes, rounded down (a nearly full mailbox never reads as having more space). */
export const kbToMb = (kb: number): number => Math.max(0, Math.floor(kb / 1024));

/** What `GET /api/mailbox/status` answers (the quota and login warnings). */
export interface MailboxStatus {
  /** The latest mailbox poll was refused at login; `at` is when it failed (epoch ms). */
  loginFailing: { at: number } | null;
  /** The last successful quota check; null until one has run. */
  quota: MailboxQuota | null;
  thresholdKb: number;
}
