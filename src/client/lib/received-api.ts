import type { ReceivedSummary } from "../../shared/import";
import type { ReceivedInvoiceRecord } from "../../shared/received";
import { api } from "./api";

export const receivedListQuery = {
  queryKey: ["received"],
  queryFn: () => api<{ received: ReceivedInvoiceRecord[] }>("/api/received"),
};

export const receivedQuery = (id: string) => ({
  queryKey: ["received", id],
  queryFn: () => api<{ received: ReceivedInvoiceRecord }>(`/api/received/${id}`),
});

export const receivedFileUrl = (id: string) => `/api/received/${id}/file`;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Reports what the browser found in a polled invoice (or that it could not read it). */
export const reportParsed = (id: string, result: { summary: ReceivedSummary } | null) =>
  api<{ received: ReceivedInvoiceRecord }>(
    `/api/received/${id}/parsed`,
    json("PUT", result ? { status: "parsed", summary: result.summary } : { status: "failed" }),
  );

export const setReceivedPayment = (id: string, paid: boolean) =>
  api<{ received: ReceivedInvoiceRecord }>(
    `/api/received/${id}`,
    json("PATCH", paid ? { paymentFlag: "paid" } : { paymentFlag: "unpaid" }),
  );
