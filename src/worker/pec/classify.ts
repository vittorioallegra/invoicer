import {
  type Daticert,
  isInvoiceFileName,
  isSdiAddress,
  normalizeMessageId,
  parseDaticert,
  parseSdiAttachmentName,
  parseSdiReceiptXml,
  type SdiMessageType,
  type SdiReceipt,
} from "../../shared/sdi-messages";
import type { ParsedAttachment, ParsedPecEnvelope } from "./envelope";

/**
 * Messages above this size are never run through the MIME parser in the Worker (CPU, see the
 * step 2 spike): they are classified from their headers and attachment names only, and a
 * received invoice keeps the raw message as its original (the browser extracts the file).
 */
export const PARSE_LIMIT_BYTES = 256 * 1024;

export type PecReceiptKind = "acceptance" | "delivery" | "non_delivery" | "other";

interface Common {
  /** The message's own Message-ID (angle brackets kept as sent), when it has one. */
  messageId: string | null;
  /** When the message was sent, from its `Date` header (epoch ms). */
  sentAt: number | null;
}

export type Classification = Common &
  (
    | { kind: "ignored" }
    | {
        kind: "pec_receipt";
        receipt: PecReceiptKind;
        /** Message-ID of the original message the receipt refers to (normalized). */
        refMessageId: string | null;
        /** Invoice file names found in the original message a complete receipt carries. */
        fileNames: string[];
        /** Addresses the original message was delivered to (`daticert.xml`). */
        recipients: string[];
        /** The sender the provider reports for the original message. */
        sender: string | null;
      }
    | {
        kind: "sdi_message";
        type: SdiMessageType;
        /** The invoice file name the SdI echoes; null when it could not be read. */
        fileName: string | null;
        receipt: SdiReceipt;
        /** Address the SdI sent it from; the first reply names the address to use next. */
        sender: string;
      }
    | {
        kind: "received_invoice";
        /** The invoice file (XML or P7M); null for a large message, whose raw `.eml` is kept. */
        attachment: ParsedAttachment | null;
        fileName: string;
        sender: string;
      }
  );

const decoder = new TextDecoder();

const timestamp = (value: string | null | undefined): number | null => {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
};

function receiptKind(tipo: string): PecReceiptKind {
  if (tipo === "accettazione") return "acceptance";
  if (tipo === "avvenuta-consegna") return "delivery";
  if (tipo === "errore-consegna" || tipo === "non-accettazione") return "non_delivery";
  return "other";
}

/**
 * Separates PEC provider receipts, SdI messages (RC, NS, MC, ...) and received invoices from
 * everything else. Only messages from the SdI count as SdI messages or invoices; whatever else
 * arrives is `ignored` (stored, never notified).
 */
export function classifyEnvelope(envelope: ParsedPecEnvelope): Classification {
  const common: Common = { messageId: envelope.messageId, sentAt: timestamp(envelope.date) };
  const dati: Daticert | null = envelope.daticert ? parseDaticert(envelope.daticert) : null;
  const tipo =
    dati?.tipo ??
    envelope.headers["x-ricevuta"]?.trim().toLowerCase() ??
    (envelope.headers["x-trasporto"] ? "posta-certificata" : null);
  if (!tipo) return { ...common, kind: "ignored" };

  const inner = envelope.inner;
  if (tipo !== "posta-certificata") {
    return {
      ...common,
      kind: "pec_receipt",
      receipt: receiptKind(tipo),
      refMessageId:
        dati?.messageId ?? normalizeMessageId(envelope.headers["x-riferimento-message-id"]),
      fileNames: (inner?.attachments ?? []).map((a) => a.filename).filter(isInvoiceFileName),
      recipients: dati?.recipients ?? [],
      sender: dati?.sender ?? null,
    };
  }

  const sender = inner?.from ?? dati?.sender ?? null;
  if (!inner || !sender || !isSdiAddress(sender)) return { ...common, kind: "ignored" };

  const invoice = inner.attachments.find((a) => isInvoiceFileName(a.filename));
  if (invoice) {
    return {
      ...common,
      kind: "received_invoice",
      attachment: invoice,
      fileName: invoice.filename,
      sender,
    };
  }
  for (const attachment of inner.attachments) {
    const named = parseSdiAttachmentName(attachment.filename);
    if (!named) continue;
    const receipt = parseSdiReceiptXml(decoder.decode(attachment.content));
    return {
      ...common,
      kind: "sdi_message",
      type: named.type,
      fileName: receipt.fileName ?? named.originalFileName,
      receipt,
      sender,
    };
  }
  return { ...common, kind: "ignored" };
}

/** The header block of a raw message (up to the first blank line), unfolded. */
function headerBlock(text: string): string {
  const end = text.search(/\r?\n\r?\n/);
  return (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
}

const headerValue = (head: string, name: string): string | null =>
  new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(head)?.[1]?.trim() || null;

/**
 * Classification of a message too large to parse in the Worker: headers and the attachment
 * names found in the raw text. Provider receipts keep only their kind (no matching data); an
 * invoice from the SdI is recognised by its file name and stored as the raw message.
 */
export function classifyLarge(source: Uint8Array): Classification {
  const text = new TextDecoder("latin1").decode(source);
  const head = headerBlock(text);
  const common: Common = {
    messageId: headerValue(head, "Message-ID"),
    sentAt: timestamp(headerValue(head, "Date")),
  };
  const ricevuta = headerValue(head, "X-Ricevuta")?.toLowerCase();
  if (ricevuta) {
    return {
      ...common,
      kind: "pec_receipt",
      receipt: receiptKind(ricevuta),
      refMessageId: normalizeMessageId(headerValue(head, "X-Riferimento-Message-ID")),
      fileNames: [],
      recipients: [],
      sender: null,
    };
  }
  if (!headerValue(head, "X-Trasporto")) return { ...common, kind: "ignored" };
  const from = headerValue(head, "From") ?? "";
  const sender = /[\w.+-]+@pec\.fatturapa\.it/i.exec(from)?.[0]?.toLowerCase();
  if (!sender) return { ...common, kind: "ignored" };
  for (const match of text.matchAll(/\bname\*?=\s*"?([^";\r\n]+)"?/gi)) {
    const fileName = (match[1] ?? "").trim();
    if (isInvoiceFileName(fileName)) {
      return { ...common, kind: "received_invoice", attachment: null, fileName, sender };
    }
  }
  return { ...common, kind: "ignored" };
}
