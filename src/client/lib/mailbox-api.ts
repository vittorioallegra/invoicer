import type { MailboxStatus } from "../../shared/mailbox-quota";
import { api } from "./api";
import { putJson } from "./settings-api";

/** The mailbox warnings (login refused, quota low); shown app-wide and refreshed while open. */
export const mailboxStatusQuery = {
  queryKey: ["mailbox", "status"],
  queryFn: () => api<MailboxStatus>("/api/mailbox/status"),
  refetchInterval: 5 * 60_000,
  retry: false,
};

export const checkMailboxQuota = () => api<MailboxStatus>("/api/mailbox/quota", { method: "POST" });

export const saveQuotaThreshold = (thresholdMb: number) =>
  putJson<MailboxStatus>("/api/mailbox/quota-threshold", { thresholdMb });
