import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeImportMeta, IMPORT_META_HEADER } from "../../shared/import";
import type { ReceivedInvoiceRecord } from "../../shared/received";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";
import { pollMailbox } from "../pec/poll";
import { plainMail, receivedInvoiceMessage } from "../pec/receipt-fixtures";
import { useMailbox as openMailbox, pollEnv, resetPolling } from "../pec/test-support";

const bindings = env as unknown as Bindings;
let owner: TestClient;

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.11.0.1", bindings));
  owner = new TestClient("10.11.0.2", bindings);
  await signIn(owner);
});
beforeEach(async () => {
  await resetPolling(env.DB);
});

const summary = {
  supplierName: "ALPHA SRL",
  supplierVat: "IT01234567890",
  number: "123",
  issueDate: "2026-10-05",
  documentType: "TD01",
  currency: "EUR",
  totalCents: 12200,
};
const bytes = (text: string) => new TextEncoder().encode(text);

async function polledInvoice(): Promise<string> {
  const server = openMailbox([{ uid: 1, source: plainMail("seed") }]);
  await pollMailbox(pollEnv);
  server.add({
    uid: 2,
    source: receivedInvoiceMessage({ id: "rx1", content: "<x>invoice</x>" }),
  });
  await pollMailbox(pollEnv);
  const row = await env.DB.prepare("SELECT id FROM received_invoices").first<{ id: string }>();
  return row?.id ?? "";
}

describe("/api/received", () => {
  it("needs a session", async () => {
    const anon = new TestClient("10.11.0.3", bindings);
    expect((await anon.json("/api/received")).status).toBe(401);
    expect((await anon.request("/api/received/x/file")).status).toBe(401);
  });

  it("lists a polled invoice as pending, serves its original, and stores what the browser read", async () => {
    const id = await polledInvoice();
    const list = await owner.json<{ received: ReceivedInvoiceRecord[] }>("/api/received");
    expect(list.body.received).toHaveLength(1);
    expect(list.body.received[0]).toMatchObject({
      id,
      parseStatus: "pending",
      supplierName: null,
      source: "pec",
      original: { fileName: "IT09876543211_00007.xml", kind: "received" },
    });

    const file = await owner.request(`/api/received/${id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Disposition")).toContain("IT09876543211_00007.xml");
    expect(await file.text()).toBe("<x>invoice</x>");

    const parsed = await owner.json<{ received: ReceivedInvoiceRecord }>(
      `/api/received/${id}/parsed`,
      { method: "PUT", body: { status: "parsed", summary } },
    );
    expect(parsed.status).toBe(200);
    expect(parsed.body.received).toMatchObject({
      parseStatus: "parsed",
      supplierName: "ALPHA SRL",
      number: "123",
      issueDate: "2026-10-05",
      totalCents: 12200,
      currency: "EUR",
    });

    const failed = await owner.json<{ received: ReceivedInvoiceRecord }>(
      `/api/received/${id}/parsed`,
      { method: "PUT", body: { status: "failed" } },
    );
    expect(failed.body.received.parseStatus).toBe("failed");
  });

  it("refuses a bad summary and an unknown invoice", async () => {
    const id = await polledInvoice();
    const bad = await owner.json(`/api/received/${id}/parsed`, {
      method: "PUT",
      body: { status: "parsed", summary: { ...summary, issueDate: "05/10/2026" } },
    });
    expect(bad.status).toBe(400);
    expect(
      (await owner.json("/api/received/nope/parsed", { method: "PUT", body: { status: "failed" } }))
        .status,
    ).toBe(404);
    expect((await owner.json("/api/received/nope")).status).toBe(404);
  });

  it("flags paid and unpaid by hand", async () => {
    const id = await polledInvoice();
    const paid = await owner.json<{ received: ReceivedInvoiceRecord }>(`/api/received/${id}`, {
      method: "PATCH",
      body: { paymentFlag: "paid", paidDate: "2026-10-20" },
    });
    expect(paid.body.received).toMatchObject({ paymentFlag: "paid", paidDate: "2026-10-20" });
    const unpaid = await owner.json<{ received: ReceivedInvoiceRecord }>(`/api/received/${id}`, {
      method: "PATCH",
      body: { paymentFlag: "unpaid" },
    });
    expect(unpaid.body.received).toMatchObject({ paymentFlag: "unpaid", paidDate: null });
  });
});

describe("POST /api/received/import", () => {
  const post = (content: Uint8Array, meta: unknown) =>
    owner.json<{ outcome: string; id: string }>("/api/received/import", {
      method: "POST",
      body: content,
      contentType: "application/octet-stream",
      headers: { [IMPORT_META_HEADER]: encodeImportMeta(meta) },
    });

  it("stores the original with its summary, and reports the same file as a duplicate", async () => {
    const meta = { fileName: "a.xml", summary };
    const first = await post(bytes("<a/>"), meta);
    expect(first.status).toBe(201);
    expect(first.body.outcome).toBe("imported");
    const stored = await owner.json<{ received: ReceivedInvoiceRecord }>(
      `/api/received/${first.body.id}`,
    );
    expect(stored.body.received).toMatchObject({
      source: "import",
      parseStatus: "parsed",
      supplierName: "ALPHA SRL",
      original: { fileName: "a.xml", kind: "import" },
    });
    const file = await owner.request(`/api/received/${first.body.id}/file`);
    expect(await file.text()).toBe("<a/>");

    // Same bytes under another summary, and same supplier/number/date with other bytes.
    const sameFile = await post(bytes("<a/>"), {
      fileName: "b.xml",
      summary: { ...summary, number: "9" },
    });
    expect(sameFile.body).toEqual({ outcome: "duplicate", id: first.body.id });
    const sameKey = await post(bytes("<other/>"), { fileName: "c.xml", summary });
    expect(sameKey.body).toEqual({ outcome: "duplicate", id: first.body.id });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM received_invoices").first<{
      n: number;
    }>();
    expect(count?.n).toBe(1);
    const files = await env.DB.prepare("SELECT COUNT(*) AS n FROM files").first<{ n: number }>();
    expect(files?.n).toBe(1);
  });

  it("refuses an empty body, a missing summary and a file over the cap", async () => {
    expect((await post(new Uint8Array(), { fileName: "a.xml", summary })).status).toBe(400);
    expect((await post(bytes("<a/>"), { fileName: "a.xml" })).status).toBe(400);
    const big = await post(new Uint8Array(2 * 1024 * 1024 + 1), { fileName: "a.xml", summary });
    expect(big.status).toBe(413);
  });
});
