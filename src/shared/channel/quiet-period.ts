/** An unknown send outcome unlocks a retry only this long after the attempt started. */
export const QUIET_PERIOD_MS = 15 * 60 * 1000;

export interface AttemptState {
  outcome: "none" | "complete" | "unknown";
  /** When the send of this attempt started (epoch ms). */
  startedAt: number;
}

export type RetryDecision =
  | { allowed: true; mode: "same_attempt" | "new_attempt" }
  | {
      allowed: false;
      reason: "already_sent" | "quiet_period" | "awaiting_poll";
      retryAt?: number;
    };

/**
 * Whether a numbered invoice in `sending` may be sent again, from its attempts (oldest first);
 * only the latest attempt counts (earlier ones were rejected by the SdI or are resolved by the
 * mailbox polling, which moves the invoice out of `sending`).
 * - latest `complete`: it is out, resolved by the receipts, never resent here;
 * - latest `none`: the server refused it, retry the same attempt (same file name);
 * - latest `unknown`: only after the quiet period, and only once a mailbox poll that started
 *   after the quiet period completed (`lastPollAt`) and still found nothing for this attempt;
 *   then with a new file progressive.
 */
export function retryDecision(
  attempts: readonly AttemptState[],
  now: number,
  lastPollAt: number | null,
): RetryDecision {
  const latest = attempts.at(-1);
  if (latest?.outcome === "complete") return { allowed: false, reason: "already_sent" };
  if (!latest || latest.outcome === "none") return { allowed: true, mode: "same_attempt" };
  const retryAt = latest.startedAt + QUIET_PERIOD_MS;
  if (now < retryAt) return { allowed: false, reason: "quiet_period", retryAt };
  if (lastPollAt === null || lastPollAt < retryAt) {
    return { allowed: false, reason: "awaiting_poll", retryAt };
  }
  return { allowed: true, mode: "new_attempt" };
}
