import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";
import { seedInvoice } from "../pec/test-support";
import { createD1FileStorage } from "../storage";
import { EXPORT_EXCLUDED } from "./export";

const bindings = env as unknown as Bindings;
let owner: TestClient;

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.8.0.1", bindings));
  owner = new TestClient("10.8.0.2", bindings);
  await signIn(owner);
});

describe("Download all data", () => {
  it("needs a session", async () => {
    const res = await new TestClient("10.8.0.3", bindings).request("/api/export");
    expect(res.status).toBe(401);
  });

  it("returns every business table as one JSON attachment, files as hex", async () => {
    const inv = await seedInvoice(env.DB, { attempts: [{ fileName: "IT1_EXPRT.xml" }] });
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 65]);
    const stored = await createD1FileStorage(env.DB).put({
      kind: "xml",
      filename: "IT1_EXPRT.xml",
      contentType: "application/xml",
      content: bytes,
      invoiceId: inv.id,
    });
    // More rows than one page, to exercise paging.
    for (let i = 0; i < 25; i++) {
      await createD1FileStorage(env.DB).put({
        kind: "pdf",
        filename: `f${i}.pdf`,
        contentType: "application/pdf",
        content: new Uint8Array([i]),
      });
    }

    const res = await owner.request("/api/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="invoicer-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const data = JSON.parse(await res.text()) as {
      exportedAt: string;
      tables: Record<string, Record<string, unknown>[]>;
    };
    expect(Date.parse(data.exportedAt)).not.toBeNaN();

    const names = Object.keys(data.tables);
    for (const table of [
      "invoices",
      "transmissions",
      "files",
      "pec_messages",
      "events",
      "outbox",
      "notifications",
      "settings",
      "job_runs",
      "clients",
      "profile",
    ]) {
      expect(names).toContain(table);
    }
    expect(data.tables.invoices?.some((r) => r.id === inv.id)).toBe(true);
    expect(data.tables.transmissions?.some((r) => r.file_name === "IT1_EXPRT.xml")).toBe(true);
    expect(data.tables.files).toHaveLength(26);
    const file = data.tables.files?.find((r) => r.id === stored.id);
    expect(file?.content_hex).toBe("000102FAFF41");
    expect(file).not.toHaveProperty("content");
  });

  it("never includes login secrets or push keys", async () => {
    const res = await owner.request("/api/export");
    const text = await res.text();
    const data = JSON.parse(text) as { tables: Record<string, unknown> };
    for (const table of EXPORT_EXCLUDED) expect(data.tables).not.toHaveProperty(table);
    expect(text).not.toContain("a-long-test-password");
    expect(text).not.toMatch(/"password"/);
  });
});
