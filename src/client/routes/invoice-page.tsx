import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { isEditedImport } from "../../shared/invoice";
import { invoiceQuery } from "../lib/invoices-api";
import { ImportedInvoicePage } from "./imported-invoice";
import { type EditorSeed, InvoiceEditorPage } from "./invoice-editor";

/**
 * `/invoices/$invoiceId`: an imported invoice that was never edited shows the file it was read
 * from; its Edit opens the editor, seeded in the browser from that file. Once edited it is shown
 * and edited like any invoice (without send, finalize or delete). Everything else is the editor.
 */
export function InvoicePage() {
  const { invoiceId } = useParams({ strict: false }) as { invoiceId?: string };
  const record = useQuery({ ...invoiceQuery(invoiceId ?? ""), enabled: invoiceId !== undefined });
  const invoice = record.data?.invoice;
  const [seed, setSeed] = useState<Omit<EditorSeed, "onLeave"> | null>(null);
  const unedited = invoice?.source === "imported" && !isEditedImport(invoice);
  if (invoice && unedited && !seed) {
    return <ImportedInvoicePage record={invoice} onEdit={setSeed} />;
  }
  return (
    <InvoiceEditorPage
      seed={seed && unedited ? { ...seed, onLeave: () => setSeed(null) } : undefined}
    />
  );
}
