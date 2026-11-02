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
