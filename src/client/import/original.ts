import type { ReceivedInvoice } from "../../shared/fatturapa";
import { apiBytes } from "../lib/api";
import { invoiceAttachments } from "./eml";
import { parseInvoiceFile } from "./read";

/** The file to hand to the owner as "the original": the XML or P7M, never the PEC envelope. */
export interface OriginalInvoice {
  fileName: string;
  bytes: Uint8Array;
  invoice: ReceivedInvoice;
}

/**
 * Loads a stored original and reads the invoice in it. A large received invoice is stored as the
 * raw PEC message (`pec_raw`): the invoice file is unpacked from it here, in the browser.
 */
export async function loadOriginal(
  url: string,
  fileName: string,
  kind: string,
): Promise<OriginalInvoice> {
  const stored = await apiBytes(url);
  let name = fileName;
  let bytes = stored;
  if (kind === "pec_raw") {
    const [attachment] = await invoiceAttachments(stored);
    if (!attachment) throw new Error("no_invoice_in_message");
    name = attachment.name;
    bytes = attachment.bytes;
  }
  return { fileName: name, bytes, invoice: parseInvoiceFile(name, bytes) };
}

/** MIME type for saving an original under its own name. */
export const originalType = (name: string): string =>
  /\.p7m$/i.test(name) ? "application/pkcs7-mime" : "application/xml";
