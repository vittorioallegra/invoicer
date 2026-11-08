import { FatturaParseError, parseFatturaXml, type ReceivedInvoice } from "../../shared/fatturapa";
import type { ImportReason } from "../../shared/import";
import { MAX_FILE_BYTES } from "../../shared/limits";
import { SDI_SIDE_FILE } from "./names";
import { extractP7m, isP7mName } from "./p7m";
import { isZip, unzipEntries } from "./zip";

/**
 * Turns what the owner picked (XML, P7M or ZIP files) into invoices ready to import. Everything
 * here runs in the browser; a file that cannot be used becomes an entry with a `reason` instead
 * of an error, so one bad file never stops the others.
 */

export interface ReadFile {
  /** Shown on the result screen: the file name, or `archive.zip/inner.xml`. */
  label: string;
  /** Name of the stored original (the entry name inside a ZIP). */
  fileName: string;
  /** Where the file came from: its name, or its full path inside the ZIP. */
  path: string;
  /** The file exactly as it was (the XML, or the P7M with its signature). */
  original: Uint8Array;
  invoice: ReceivedInvoice | null;
  reason: ImportReason | null;
}

/** Decodes an XML file honouring a non-UTF-8 `encoding` declaration (default UTF-8, BOM skipped). */
export function decodeXml(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const label = /<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9_.:-]+)["']/.exec(head)?.[1];
  try {
    return new TextDecoder(label ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** The invoice XML bytes of a file: the P7M's signed content, or the file itself. */
export function invoiceXmlBytes(fileName: string, bytes: Uint8Array): Uint8Array {
  return isP7mName(fileName) || (bytes[0] === 0x30 && bytes[1] !== undefined && bytes[1] >= 0x80)
    ? extractP7m(bytes)
    : bytes;
}

/** Parses the invoice in a file, or throws `FatturaParseError` / `P7mError`. */
export function parseInvoiceFile(fileName: string, bytes: Uint8Array): ReceivedInvoice {
  return parseFatturaXml(decodeXml(invoiceXmlBytes(fileName, bytes)));
}

function readOne(label: string, fileName: string, bytes: Uint8Array, path = fileName): ReadFile {
  const base = { label, fileName, path, original: bytes };
  if (bytes.byteLength > MAX_FILE_BYTES) return { ...base, invoice: null, reason: "too_large" };
  try {
    return { ...base, invoice: parseInvoiceFile(fileName, bytes), reason: null };
  } catch (error) {
    if (error instanceof FatturaParseError || (error as Error).name === "P7mError") {
      return { ...base, invoice: null, reason: "unreadable" };
    }
    throw error;
  }
}

/** Reads one picked file; a ZIP yields one entry per file inside it. */
export function readImportFile(name: string, bytes: Uint8Array): ReadFile[] {
  if (!isZip(bytes)) return [readOne(name, name, bytes)];
  let entries: ReturnType<typeof unzipEntries>;
  try {
    entries = unzipEntries(bytes);
  } catch {
    return [
      {
        label: name,
        fileName: name,
        path: name,
        original: bytes,
        invoice: null,
        reason: "unreadable",
      },
    ];
  }
  const files = entries.filter((entry) => !SDI_SIDE_FILE.test(entry.name));
  if (files.length === 0) {
    return [
      {
        label: name,
        fileName: name,
        path: name,
        original: bytes,
        invoice: null,
        reason: "empty_archive",
      },
    ];
  }
  return files.map((entry) =>
    readOne(`${name}/${entry.name}`, entry.name, entry.bytes, entry.path),
  );
}
