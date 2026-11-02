import { XMLParser } from "fast-xml-parser";

/**
 * Pure parsing of the small documents the PEC mailbox delivers: SdI messages (receipts and
 * notices carried as `<file>_<TYPE>_<nnn>.xml`) and the PEC provider's `daticert.xml`. Only small
 * documents go through here; invoices and P7M are parsed in the browser.
 */

/** SdI message types by their file name infix; RC, NS and MC drive the invoice state. */
export const SDI_MESSAGE_TYPES = ["RC", "NS", "MC", "NE", "DT", "AT", "SE", "EC", "MT"] as const;
export type SdiMessageType = (typeof SDI_MESSAGE_TYPES)[number];

const RECEIPT_NAME = new RegExp(`^(.+)_(${SDI_MESSAGE_TYPES.join("|")})_(\\d{1,3})\\.xml$`, "i");

/** `IT123_00001_RC_001.xml` -> type RC and the original file name `IT123_00001.xml`. */
export function parseSdiAttachmentName(
  name: string,
): { type: SdiMessageType; originalFileName: string } | null {
  const match = RECEIPT_NAME.exec(name.trim());
  if (!match) return null;
  return {
    type: (match[2] as string).toUpperCase() as SdiMessageType,
    originalFileName: `${match[1]}.xml`,
  };
}

/** Whether a file name looks like an invoice file (FatturaPA XML, optionally signed). */
export function isInvoiceFileName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (lower === "daticert.xml" || parseSdiAttachmentName(lower)) return false;
  return lower.endsWith(".xml") || lower.endsWith(".xml.p7m") || lower.endsWith(".p7m");
}

const SDI_DOMAIN = "@pec.fatturapa.it";

/** An address of the SdI: its PEC domain, or the address the SdI assigned (settings). */
export function isSdiAddress(
  address: string | null | undefined,
  assigned?: string | null,
): boolean {
  const value = address?.trim().toLowerCase();
  if (!value) return false;
  return value.endsWith(SDI_DOMAIN) || (assigned ? value === assigned.trim().toLowerCase() : false);
}

/** A Message-ID without angle brackets and case, to compare ids across headers and XML. */
export function normalizeMessageId(id: string | null | undefined): string | null {
  const value = id?.trim().replace(/^<|>$/g, "").trim().toLowerCase();
  return value ? value : null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === "Errore" || name === "destinatari",
});

type Tree = Record<string, unknown>;
const isTree = (value: unknown): value is Tree =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asTree = (value: unknown): Tree => (isTree(value) ? value : {});
const text = (value: unknown): string | null => {
  if (typeof value === "string") return value === "" ? null : value;
  if (isTree(value) && typeof value["#text"] === "string") return value["#text"] || null;
  return null;
};

function parseXml(xml: string): Tree {
  try {
    return asTree(parser.parse(xml));
  } catch {
    return {};
  }
}

const ROOT_TYPES: Record<string, SdiMessageType> = {
  RicevutaConsegna: "RC",
  NotificaScarto: "NS",
  NotificaMancataConsegna: "MC",
  NotificaEsito: "NE",
  NotificaDecorrenzaTermini: "DT",
  AttestazioneTrasmissioneFattura: "AT",
  ScartoEsitoCommittente: "SE",
  NotificaEsitoCommittente: "EC",
};

export interface SdiError {
  code: string;
  description: string;
}

export interface SdiReceipt {
  type: SdiMessageType | null;
  /** The invoice file name the SdI echoes (`NomeFile`). */
  fileName: string | null;
  /** SdI error list of an NS (`ListaErrori`). */
  errors: SdiError[];
  /** Free text of an MC (`Descrizione`). */
  description: string | null;
}

/** Reads an RC / NS / MC receipt (or any SdI notice root); unknown documents give nulls. */
export function parseSdiReceiptXml(xml: string): SdiReceipt {
  const tree = parseXml(xml);
  const rootName = Object.keys(tree).find((key) => key in ROOT_TYPES) ?? null;
  const root = asTree(rootName ? tree[rootName] : null);
  const list = asTree(root.ListaErrori).Errore;
  const errors = (Array.isArray(list) ? list : [])
    .filter(isTree)
    .map((e) => ({ code: text(e.Codice) ?? "", description: text(e.Descrizione) ?? "" }))
    .filter((e) => e.code !== "" || e.description !== "");
  return {
    type: rootName ? (ROOT_TYPES[rootName] ?? null) : null,
    fileName: text(root.NomeFile),
    errors,
    description: text(root.Descrizione),
  };
}

export interface Daticert {
  /** `posta-certificata`, `accettazione`, `avvenuta-consegna`, `errore-consegna`, ... */
  tipo: string | null;
  sender: string | null;
  recipients: string[];
  /** Message-ID of the message the receipt refers to (normalized). */
  messageId: string | null;
}

/** Reads the PEC provider's certification data. */
export function parseDaticert(xml: string): Daticert {
  const root = asTree(parseXml(xml).postacert);
  const header = asTree(root.intestazione);
  const data = asTree(root.dati);
  const recipients = Array.isArray(header.destinatari) ? header.destinatari : [];
  return {
    tipo: typeof root["@_tipo"] === "string" ? (root["@_tipo"] as string).toLowerCase() : null,
    sender: text(header.mittente)?.toLowerCase() ?? null,
    recipients: recipients.map(text).filter((v): v is string => v !== null),
    messageId: normalizeMessageId(text(data.msgid)),
  };
}
