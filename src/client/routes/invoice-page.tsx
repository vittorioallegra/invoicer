import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { invoiceQuery } from "../lib/invoices-api";
import { ImportedInvoicePage } from "./imported-invoice";
import { InvoiceEditorPage } from "./invoice-editor";

/** `/invoices/$invoiceId`: an imported invoice is read-only (its file is shown), the rest is the editor. */
export function InvoicePage() {
  const { invoiceId } = useParams({ strict: false }) as { invoiceId?: string };
  const record = useQuery({ ...invoiceQuery(invoiceId ?? ""), enabled: invoiceId !== undefined });
  const invoice = record.data?.invoice;
  if (invoice?.source === "imported") return <ImportedInvoicePage record={invoice} />;
  return <InvoiceEditorPage />;
}
