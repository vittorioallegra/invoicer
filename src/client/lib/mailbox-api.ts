import type { MailboxStatus } from "../../shared/mailbox-status";
import { api } from "./api";

/** The mailbox login warning; shown app-wide and refreshed while open. */
export const mailboxStatusQuery = {
  queryKey: ["mailbox", "status"],
  queryFn: () => api<MailboxStatus>("/api/mailbox/status"),
  refetchInterval: 5 * 60_000,
  retry: false,
};
