import { Hono } from "hono";
import { romeDateTime } from "../../shared/cron";
import type { SessionVariables } from "../auth/session";
import type { Bindings } from "../env";

export const exportData = new Hono<{ Bindings: Bindings; Variables: SessionVariables }>();

/**
 * Tables that never leave the database through the export: the login (password hashes, TOTP
 * secrets, passkeys, sessions) and push subscription keys are secrets, and a downloaded file is
 * easier to lose than D1. They come back with D1 Time Travel, or by creating the owner again
 * with `SETUP_TOKEN` and re-registering devices.
 */
export const EXPORT_EXCLUDED = new Set([
  "user",
  "session",
  "account",
  "verification",
  "two_factor",
  "passkey",
  "rate_limit",
  "send_challenges",
  "push_subscriptions",
  "d1_migrations",
]);

const PAGE_ROWS = 200;
/** Files carry BLOBs: fewer rows per page keep memory and CPU per pull small. */
const PAGE_FILES = 10;

async function exportableTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`,
    )
    .all<{ name: string }>();
  return results.map((r) => r.name).filter((name) => !EXPORT_EXCLUDED.has(name));
}

/** `SELECT` list of a table; BLOB columns are read as hex text by SQLite (no JS byte loops). */
async function selectList(db: D1Database, table: string): Promise<string> {
  const { results } = await db
    .prepare("SELECT name, type FROM pragma_table_info(?)")
    .bind(table)
    .all<{ name: string; type: string }>();
  return results
    .map((c) =>
      c.type.toUpperCase() === "BLOB" ? `hex("${c.name}") AS "${c.name}_hex"` : `"${c.name}"`,
    )
    .join(", ");
}

/**
 * Streams a JSON document with every exportable table, a page of rows at a time:
 * `{ exportedAt, tables: { <name>: [rows] } }`. BLOB columns appear as `<column>_hex`.
 */
export function exportStream(db: D1Database, now = new Date()): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let tables: string[] | null = null;
  let tableIndex = 0;
  let offset = 0;
  let select = "";
  let opened = false;
  let firstTable = true;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const out = (text: string) => controller.enqueue(encoder.encode(text));
      try {
        if (tables === null) {
          tables = await exportableTables(db);
          out(`{"exportedAt":${JSON.stringify(now.toISOString())},"tables":{`);
        }
        const table = tables[tableIndex];
        if (table === undefined) {
          out("}}");
          controller.close();
          return;
        }
        if (!opened) {
          select = await selectList(db, table);
          out(`${firstTable ? "" : ","}${JSON.stringify(table)}:[`);
          opened = true;
          firstTable = false;
          offset = 0;
        }
        const limit = table === "files" ? PAGE_FILES : PAGE_ROWS;
        const { results } = await db
          .prepare(`SELECT ${select} FROM "${table}" ORDER BY rowid LIMIT ? OFFSET ?`)
          .bind(limit, offset)
          .all();
        if (results.length > 0) {
          out(`${offset > 0 ? "," : ""}${results.map((row) => JSON.stringify(row)).join(",")}`);
          offset += results.length;
        }
        if (results.length < limit) {
          out("]");
          opened = false;
          tableIndex += 1;
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** "Download all data": the owner's manual backup next to D1 Time Travel. */
exportData.get("/", (c) => {
  const date = romeDateTime(new Date()).date;
  return new Response(exportStream(c.env.DB), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="invoicer-export-${date}.json"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
