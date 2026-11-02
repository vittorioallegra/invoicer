import type { InvoiceListScope, InvoiceRecord, InvoiceSummary } from "../../shared/invoice";
import { api } from "./api";

export const invoicesQuery = (scope: InvoiceListScope) => ({
  queryKey: ["invoices", scope],
  queryFn: () => api<{ invoices: InvoiceSummary[] }>(`/api/invoices?scope=${scope}`),
});

export const invoiceQuery = (id: string) => ({
  queryKey: ["invoice", id],
  queryFn: () => api<{ invoice: InvoiceRecord }>(`/api/invoices/${id}`),
});

const send = <T>(method: string, path: string, body?: unknown) =>
  api<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });

type One = { invoice: InvoiceRecord };

export const createInvoice = (body: unknown) => send<One>("POST", "/api/invoices", body);
export const updateInvoice = (id: string, body: unknown) =>
  send<One>("PUT", `/api/invoices/${id}`, body);
export const patchInvoice = (id: string, body: unknown) =>
  send<One>("PATCH", `/api/invoices/${id}`, body);
export const deleteInvoice = (id: string) => send<null>("DELETE", `/api/invoices/${id}`);
export const duplicateInvoice = (id: string) =>
  send<One>("POST", `/api/invoices/${id}/duplicate`, {});
export const createCreditNote = (id: string) =>
  send<One>("POST", `/api/invoices/${id}/credit-note`, {});
export const reissueInvoice = (id: string) => send<One>("POST", `/api/invoices/${id}/reissue`, {});
export const releaseNumber = (id: string) =>
  send<One>("POST", `/api/invoices/${id}/release-number`, {});

export interface TransmissionsInfo {
  attempts: {
    id: string;
    attempt: number;
    fileName: string;
    channel: "pec" | "manual";
    outcome: "none" | "complete" | "unknown";
    sdiPecAddress: string | null;
    hasXml: boolean;
    hasPdf: boolean;
    startedAt: number;
  }[];
  retry:
    | { allowed: true; mode: "same_attempt" | "new_attempt" }
    | { allowed: false; reason: string; retryAt?: number };
}

export const transmissionsQuery = (id: string) => ({
  queryKey: ["transmissions", id],
  queryFn: () => api<TransmissionsInfo>(`/api/invoices/${id}/transmissions`),
});

export interface Reservation {
  number: number;
  year: number;
  issueDate: string;
  reused: boolean;
  transmission: { id: string; attempt: number; fileProgressive: number; fileName: string };
}

export const reserveNumber = (id: string) =>
  send<{ reservation: Reservation; invoice: InvoiceRecord }>(
    "POST",
    `/api/invoices/${id}/reserve-number`,
    {},
  );
export const newAttempt = (id: string) =>
  send<{ transmission: { id: string; attempt: number; fileName: string } }>(
    "POST",
    `/api/invoices/${id}/new-attempt`,
    {},
  );
export const uploadXml = (id: string, xml: Uint8Array) =>
  api<{ file: { sha256: string } }>(`/api/invoices/${id}/xml`, {
    method: "PUT",
    headers: { "Content-Type": "application/xml" },
    body: xml as BodyInit,
  });
export const requestSendChallenge = (id: string, xmlSha256: string) =>
  send<{
    challengeId: string;
    options: unknown;
    passkeyAvailable: boolean;
    totpAvailable: boolean;
  }>("POST", `/api/invoices/${id}/send-challenge`, { xmlSha256 });
export const sendInvoice = (id: string, answer: unknown) =>
  send<{ messageId: string; fileName: string; to: string }>("POST", `/api/invoices/${id}/send`, {
    answer,
  });
export const manualHandedOver = (id: string) =>
  send<{ ok: true }>("POST", `/api/invoices/${id}/manual/handed-over`, {});
export const manualOutcome = (
  id: string,
  body: {
    outcome: "delivered" | "not_delivered" | "rejected";
    errors?: { code: string; description: string }[];
  },
) => send<{ state: string }>("POST", `/api/invoices/${id}/manual/outcome`, body);
