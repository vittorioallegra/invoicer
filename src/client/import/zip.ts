import { unzipSync } from "fflate";

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/** True for a ZIP archive (local file header or an empty archive). */
export const isZip = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);

/** The files of a ZIP archive (folders and macOS metadata skipped), file names without folders. */
export function unzipEntries(bytes: Uint8Array): ZipEntry[] {
  const files = unzipSync(bytes);
  return Object.entries(files)
    .filter(([name]) => !name.endsWith("/") && !name.startsWith("__MACOSX/"))
    .map(([name, content]) => ({ name: name.split("/").pop() ?? name, bytes: content }));
}
