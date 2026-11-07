import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, setupOwner, signIn, TestClient } from "../auth/test-helpers";
import type { Bindings } from "../env";
import { remindUnsentInvoices } from "../jobs/invoice-due";

interface ListResponse {
  unread: number;
  notifications: { id: string }[];
}

let owner: TestClient;

async function notify(id: string, readAt: number | null = null) {
  await env.DB.prepare(
    `INSERT INTO notifications (id, type, title, body, read_at, created_at)
     VALUES (?, 'received_invoice', 'notifications.received_invoice.title', '{}', ?, ?)`,
  )
    .bind(id, readAt, Date.now())
    .run();
}

const list = async () => (await owner.json<ListResponse>("/api/notifications")).body;

beforeAll(async () => {
  await applyMigrations(env.DB);
  await setupOwner(new TestClient("10.9.0.1", env as unknown as Bindings));
  owner = new TestClient("10.9.0.2", env as unknown as Bindings);
  await signIn(owner);
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM notifications").run();
});

describe("deleting notifications", () => {
  it("removes one from the list and from the unread count", async () => {
    await notify("a");
    await notify("b");
    expect((await list()).unread).toBe(2);

    const done = await owner.json("/api/notifications/a", { method: "DELETE" });
    expect(done.status).toBe(200);
    const after = await list();
    expect(after.notifications.map((n) => n.id)).toEqual(["b"]);
    expect(after.unread).toBe(1);
  });

  it("removes them all", async () => {
    await notify("a");
    await notify("b", Date.now() - 1000);
    expect((await owner.json("/api/notifications", { method: "DELETE" })).status).toBe(200);
    expect(await list()).toEqual({ unread: 0, notifications: [] });
  });

  it("ignores an unknown id and a repeated delete", async () => {
    await notify("a");
    expect((await owner.json("/api/notifications/nope", { method: "DELETE" })).status).toBe(200);
    expect((await owner.json("/api/notifications/a", { method: "DELETE" })).status).toBe(200);
    expect((await owner.json("/api/notifications/a", { method: "DELETE" })).status).toBe(200);
    expect((await list()).notifications).toEqual([]);
  });

  it("needs a session", async () => {
    const anonymous = new TestClient("10.9.0.3", env as unknown as Bindings);
    expect((await anonymous.json("/api/notifications/a", { method: "DELETE" })).status).toBe(401);
    expect((await anonymous.json("/api/notifications", { method: "DELETE" })).status).toBe(401);
  });

  it("keeps the row, so a reminder that was already written does not come back", async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO clients (id, type, name, country_code, created_at)
       VALUES ('c-del', 'it_company', 'Acme S.r.l.', 'IT', 1)`,
    ).run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO invoices (id, state, planned_date, client_id, created_at)
       VALUES ('inv-del', 'draft', '2026-06-10', 'c-del', 1)`,
    ).run();
    const bindings = env as unknown as Bindings;
    const now = new Date("2026-06-10T07:00:00Z");
    expect(await remindUnsentInvoices(bindings, now)).toBe(1);
    expect((await list()).notifications).toHaveLength(1);

    expect((await owner.json("/api/notifications", { method: "DELETE" })).status).toBe(200);
    expect((await list()).notifications).toEqual([]);
    // The daily job runs again: the deleted reminder is not written a second time.
    expect(await remindUnsentInvoices(bindings, now)).toBe(0);
    expect((await list()).notifications).toEqual([]);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n, MIN(dismissed_at) AS at, MIN(read_at) AS readAt FROM notifications",
    ).first<{ n: number; at: number | null; readAt: number | null }>();
    expect(row?.n).toBe(1);
    expect(row?.at).not.toBeNull();
    expect(row?.readAt).not.toBeNull();
  });
});
