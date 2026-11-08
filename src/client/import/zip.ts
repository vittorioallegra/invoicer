import { unzipSync } from "fflate";

export interface ZipEntry {
  /** File name without folders. */
  name: string;
  /** Full path inside the archive (`folder/sub/file.xml`). */
  path: string;
  bytes: Uint8Array;
}

/** True for a ZIP archive (local file header or an empty archive). */
export const isZip = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);

/** An invoice file by its name: FatturaPA XML or its signed P7M. */
const INVOICE_FILE = /\.(xml|p7m)$/i;

/**
 * Whether an archive entry can be an invoice file. Folders, macOS metadata (`__MACOSX/`,
 * `._file`, `.DS_Store`) and everything that is not an XML or P7M (PDFs, spreadsheets...) are not
 * invoices and are ignored without a word.
 */
export function isInvoiceEntry(path: string): boolean {
  if (path.endsWith("/")) return false;
  const parts = path.split("/");
  if (parts.includes("__MACOSX")) return false;
  const name = parts[parts.length - 1] ?? "";
  return !name.startsWith(".") && INVOICE_FILE.test(name);
}

/** The invoice files of a ZIP archive; the other entries are not even decompressed. */
export function unzipEntries(bytes: Uint8Array): ZipEntry[] {
  const files = unzipSync(bytes, { filter: (file) => isInvoiceEntry(file.name) });
  return Object.entries(files)
    .filter(([path]) => isInvoiceEntry(path))
    .map(([path, content]) => ({
      name: path.split("/").pop() ?? path,
      path,
      bytes: content,
    }));
}
