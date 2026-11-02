/**
 * Server replies as `worker-mailer` 1.3.0 words them in thrown errors (recorded from its source
 * and Aruba's documented SMTP replies). Test support only.
 */
export const SMTP_ERRORS = {
  authFailed: "Failed to plain authentication: 535 5.7.8 Authentication credentials invalid",
  authLogin: "Failed to login authentication: 535 5.7.8 Error: authentication failed",
  mailboxFull: "Failed send email body: 552 5.2.2 Mailbox full, quota exceeded",
  rcptRefused: "Invalid RCPT TO: <x@pec.example.it> 550 5.1.1 User unknown",
  bodyRefused: "Failed send email body: 554 5.7.1 Message refused",
  timeout: "Timeout while waiting for smtp server response",
  closed: "SMTP connection closed by server",
  greeting: "Failed to connect to SMTP server: 421 Service not available",
} as const;
