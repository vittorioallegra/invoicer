/** What `GET /api/mailbox/status` answers (the mailbox login warning). */
export interface MailboxStatus {
  /** The latest mailbox poll was refused at login; `at` is when it failed (epoch ms). */
  loginFailing: { at: number } | null;
}
