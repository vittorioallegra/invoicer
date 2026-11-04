import { type FILE_KINDS, MAX_FILE_BYTES } from "../db/schema";
import { makeError } from "./problem";

export type FileKind = (typeof FILE_KINDS)[number];

export interface StoredFileInput {
  kind: FileKind;
  filename: string;
  contentType: string;
  content: Uint8Array;
  invoiceId?: string;
  transmissionId?: string;
  receivedInvoiceId?: string;
}

export interface StoredFile {
  id: string;
  kind: FileKind;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  content: Uint8Array;
}

/**
 * The only way application code reads and writes files. The D1 BLOB backend below can be
 * replaced by an R2 backend without touching callers.
 */
export interface FileStorage {
  put(input: StoredFileInput): Promise<{ id: string; size: number; sha256: string }>;
  get(id: string): Promise<StoredFile | null>;
  delete(id: string): Promise<void>;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createD1FileStorage(db: D1Database): FileStorage {
  return {
    async put(input) {
      const size = input.content.byteLength;
      if (size > MAX_FILE_BYTES) {
        throw makeError(
          "payload_too_large",
          `${input.filename} is ${size} bytes; files are limited to ${MAX_FILE_BYTES / (1024 * 1024)} MB.`,
        );
      }
      const id = crypto.randomUUID();
      const sha256 = await sha256Hex(input.content);
      await db
        .prepare(
          `INSERT INTO files (id, kind, invoice_id, transmission_id, received_invoice_id,
             filename, content_type, size, sha256, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          input.kind,
          input.invoiceId ?? null,
          input.transmissionId ?? null,
          input.receivedInvoiceId ?? null,
          input.filename,
          input.contentType,
          size,
          sha256,
          input.content,
          Date.now(),
        )
        .run();
      return { id, size, sha256 };
    },

    async get(id) {
      const row = await db
        .prepare(
          "SELECT id, kind, filename, content_type, size, sha256, content FROM files WHERE id = ?",
        )
        .bind(id)
        .first<{
          id: string;
          kind: FileKind;
          filename: string;
          content_type: string;
          size: number;
          sha256: string;
          content: ArrayBuffer;
        }>();
      if (!row) return null;
      return {
        id: row.id,
        kind: row.kind,
        filename: row.filename,
        contentType: row.content_type,
        size: row.size,
        sha256: row.sha256,
        content: new Uint8Array(row.content),
      };
    },

    async delete(id) {
      await db.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
    },
  };
}
