import { api } from "./api";

export interface CourtesyDraft {
  to: string;
  subject: string;
  body: string;
  from: string | null;
  replyTo: string | null;
  bcc: string | null;
  attachments: { filename: string; size: number }[];
}

export interface CourtesyLogEntry {
  id: string;
  attempt: number | null;
  trigger: "automatic" | "ask" | "manual" | null;
  recipient: string;
  subject: string | null;
  messageId: string | null;
  status: "sent" | "failed";
  error: string | null;
  at: number;
}

export interface CourtesyOverview {
  /** The email as it would go out now; null while the invoice has no stored PDF. */
  draft: CourtesyDraft | null;
  /** The offer waiting for Send / Skip (mode "ask"). */
  ask: { id: string; attempt: number } | null;
  /** The Resend key and a sender address are set. */
  ready: boolean;
  log: CourtesyLogEntry[];
}

export const courtesyEmailQuery = (invoiceId: string) => ({
  queryKey: ["courtesy-email", invoiceId],
  queryFn: () => api<CourtesyOverview>(`/api/invoices/${invoiceId}/courtesy-email`),
});

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export interface CourtesySendBody {
  requestId: string;
  to: string;
  subject: string;
  body: string;
  outboxId?: string;
}

export const sendCourtesyEmail = (invoiceId: string, body: CourtesySendBody) =>
  api<{ id: string; messageId: string }>(`/api/invoices/${invoiceId}/courtesy-email`, json(body));

export const skipCourtesyEmail = (invoiceId: string, outboxId: string) =>
  api<null>(`/api/invoices/${invoiceId}/courtesy-email/skip`, json({ outboxId }));
