/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { lastCompletedDailyDate } from "../worker/jobs/job-runs";
import { createD1FileStorage } from "../worker/storage";
import { MAX_FILE_BYTES } from "./schema";

const migrations = import.meta.glob("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const run = (sql: string, ...params: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...params)
    .run();
const failsWith = async (promise: Promise<unknown>, pattern: RegExp) => {
  await expect(promise).rejects.toThrow(pattern);
};

beforeAll(async () => {
  for (const file of Object.keys(migrations).sort()) {
    const statements = (migrations[file] ?? "").split("--> statement-breakpoint");
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  }
});

const invoice = (id: string, year: number | null, numberInt: number | null) =>
  run(
    "INSERT INTO invoices (id, year, number_int, created_at) VALUES (?, ?, ?, ?)",
    id,
    year,
    numberInt,
    Date.now(),
  );

describe("first migration", () => {
  it("creates the tables and not the spike table", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\'",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of ["invoices", "transmissions", "files", "pec_messages", "send_challenges"]) {
      expect(names).toContain(t);
    }
    expect(names).not.toContain("spike_kv");
  });

  it("enforces unique invoice numbers per year, allowing drafts without a number", async () => {
    await invoice("i1", 2026, 1);
    await failsWith(invoice("i2", 2026, 1), /UNIQUE/);
    await invoice("i3", 2027, 1);
    await invoice("d1", null, null);
    await invoice("d2", null, null);
  });

  it("rejects unknown invoice states", async () => {
    await failsWith(run("UPDATE invoices SET state = 'bogus' WHERE id = 'i1'"), /CHECK/);
  });

  it("keeps PEC messages unique by Message-ID and by UIDVALIDITY + UID", async () => {
    const insert = (messageId: string, uid: number) =>
      run(
        `INSERT INTO pec_messages (id, message_id, uid_validity, uid, kind, size, created_at)
         VALUES (?, ?, 1, ?, 'ignored', 10, ?)`,
        crypto.randomUUID(),
        messageId,
        uid,
        Date.now(),
      );
    await insert("<a@pec>", 1);
    await failsWith(insert("<a@pec>", 2), /UNIQUE/);
    await failsWith(insert("<b@pec>", 1), /UNIQUE/);
    await insert("<b@pec>", 2);
  });

  it("keeps received invoices unique per source PEC message", async () => {
    const row = await env.DB.prepare("SELECT id FROM pec_messages LIMIT 1").first<{ id: string }>();
    const id = row?.id ?? "";
    const insert = () =>
      run(
        "INSERT INTO received_invoices (id, pec_message_id, created_at) VALUES (?, ?, ?)",
        crypto.randomUUID(),
        id,
        Date.now(),
      );
    await insert();
    await failsWith(insert(), /UNIQUE/);
  });

  it("keeps transmission file names and attempts unique", async () => {
    const insert = (attempt: number, progressive: number, name: string) =>
      run(
        `INSERT INTO transmissions (id, invoice_id, attempt, file_progressive, file_name, channel, created_at)
         VALUES (?, 'i1', ?, ?, ?, 'pec', ?)`,
        crypto.randomUUID(),
        attempt,
        progressive,
        name,
        Date.now(),
      );
    await insert(1, 1, "IT123_00001.xml");
    await failsWith(insert(1, 2, "IT123_00002.xml"), /UNIQUE/);
    await failsWith(insert(2, 1, "IT123_00003.xml"), /UNIQUE/);
    await failsWith(insert(2, 3, "IT123_00001.xml"), /UNIQUE/);
  });

  it("keeps outbox, events and recurring occurrences unique", async () => {
    const outbox = () =>
      run(
        "INSERT INTO outbox (id, invoice_id, attempt, kind, created_at) VALUES (?, 'i1', 1, 'email', ?)",
        crypto.randomUUID(),
        Date.now(),
      );
    await outbox();
    await failsWith(outbox(), /UNIQUE/);

    const event = () =>
      run(
        "INSERT INTO events (id, source_id, type, created_at) VALUES (?, 'src-1', 'RC', ?)",
        crypto.randomUUID(),
        Date.now(),
      );
    await event();
    await failsWith(event(), /UNIQUE/);

    await run(
      "INSERT INTO clients (id, type, name, created_at) VALUES ('c1', 'it_company', 'Acme', ?)",
      Date.now(),
    );
    await run(
      `INSERT INTO recurring_templates (id, client_id, body, interval_months, day_of_month, start_date, created_at)
       VALUES ('t1', 'c1', '{}', 1, 1, '2026-01-01', ?)`,
      Date.now(),
    );
    const occurrence = () =>
      run(
        "INSERT INTO recurring_occurrences (id, template_id, occurrence_date, created_at) VALUES (?, 't1', '2026-02-01', ?)",
        crypto.randomUUID(),
        Date.now(),
      );
    await occurrence();
    await failsWith(occurrence(), /UNIQUE/);
  });

  it("keeps the single-row tables single", async () => {
    await run("INSERT INTO file_sequence (id, last_value) VALUES (1, 0)");
    await failsWith(run("INSERT INTO file_sequence (id, last_value) VALUES (2, 0)"), /CHECK/);
  });
});

describe("file storage", () => {
  const storage = () => createD1FileStorage(env.DB);

  it("stores, reads back and deletes a file with its hash", async () => {
    const content = new TextEncoder().encode("<xml/>");
    const put = await storage().put({
      kind: "xml",
      filename: "a.xml",
      contentType: "application/xml",
      content,
      invoiceId: "i1",
    });
    expect(put.size).toBe(6);
    expect(put.sha256).toHaveLength(64);
    const got = await storage().get(put.id);
    expect(got && new TextDecoder().decode(got.content)).toBe("<xml/>");
    await storage().delete(put.id);
    expect(await storage().get(put.id)).toBeNull();
  });

  it("refuses files over 2 MB with a clear error", async () => {
    const content = new Uint8Array(MAX_FILE_BYTES + 1);
    await expect(
      storage().put({
        kind: "pec_raw",
        filename: "big.eml",
        contentType: "message/rfc822",
        content,
      }),
    ).rejects.toMatchObject({ code: "payload_too_large", status: 413 });
  });

  it("enforces the size cap in the database as well", async () => {
    await failsWith(
      run(
        `INSERT INTO files (id, kind, filename, content_type, size, sha256, content, created_at)
         VALUES ('big', 'xml', 'x', 'x', ?, 'h', x'00', ?)`,
        MAX_FILE_BYTES + 1,
        Date.now(),
      ),
      /CHECK/,
    );
  });
});

describe("daily job lookup", () => {
  it("returns the latest successful daily run date", async () => {
    expect(await lastCompletedDailyDate(env)).toBeNull();
    const insert = (date: string, status: string) =>
      run(
        "INSERT INTO job_runs (id, job, run_date, started_at, status) VALUES (?, 'daily', ?, ?, ?)",
        crypto.randomUUID(),
        date,
        Date.now(),
        status,
      );
    await insert("2026-11-02", "success");
    await insert("2026-11-03", "failed");
    expect(await lastCompletedDailyDate(env)).toBe("2026-11-02");
  });
});
