import type { PaymentState } from "./invoice-state";

/** A received invoice as the list and the viewer see it. */
export interface ReceivedInvoiceRecord {
  id: string;
  /** `pending` until the browser has read the file (the Worker never parses invoices). */
  parseStatus: "pending" | "parsed" | "failed";
  supplierName: string | null;
  supplierVat: string | null;
  number: string | null;
  issueDate: string | null;
  documentType: string | null;
  currency: string;
  totalCents: number | null;
  paymentFlag: Exclude<PaymentState, "overdue">;
  paidDate: string | null;
  /** Found by the mailbox poll (`pec`) or imported by hand (`import`). */
  source: "pec" | "import";
  receivedAt: number;
  /** The stored original: file name, kind (`pec_raw` = the whole PEC message) and size. */
  original: { fileName: string; kind: string; size: number } | null;
}
