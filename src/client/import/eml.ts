import PostalMime from "postal-mime";
import { SDI_SIDE_FILE } from "./names";

/**
 * Unpacks a raw PEC message (`.eml`) in the browser: finds the invoice file (XML or `.p7m`) inside
 * the envelope's `postacert.eml`. Used for received invoices too large for the Worker to parse
 * (their original is stored as the raw message, `files.kind = pec_raw`).
 */

export interface InvoiceAttachment {
  name: string;
  bytes: Uint8Array;
}

const INVOICE_NAME = /\.(xml|p7m)$/i;

type Attachment = { filename?: string | null; content: ArrayBuffer | Uint8Array | string };

const toBytes = (a: Attachment): Uint8Array =>
  typeof a.content === "string"
    ? new TextEncoder().encode(a.content)
    : new Uint8Array(a.content as ArrayBuffer);

async function attachmentsOf(source: Uint8Array): Promise<Attachment[]> {
  const email = await PostalMime.parse(source, { forceRfc822Attachments: true });
  return email.attachments;
}

/** The invoice attachments of a PEC message, looking one level into `postacert.eml`. */
export async function invoiceAttachments(eml: Uint8Array): Promise<InvoiceAttachment[]> {
  const outer = await attachmentsOf(eml);
  const found: InvoiceAttachment[] = [];
  const collect = (list: Attachment[]) => {
    for (const a of list) {
      const name = a.filename ?? "";
      // Receipts and the PEC's own XML (daticert.xml, smime.p7s) are not invoices.
      if (
        INVOICE_NAME.test(name) &&
        !SDI_SIDE_FILE.test(name) &&
        name.toLowerCase() !== "daticert.xml"
      ) {
        found.push({ name, bytes: toBytes(a) });
      }
    }
  };
  collect(outer);
  const postacert = outer.find((a) => a.filename?.toLowerCase() === "postacert.eml");
  if (postacert) collect(await attachmentsOf(toBytes(postacert)));
  return found;
}
