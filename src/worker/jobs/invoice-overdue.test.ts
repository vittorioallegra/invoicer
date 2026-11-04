import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../auth/test-helpers";
import type { Bindings } from "../env";
import { notifyOverdueInvoices, OVERDUE_MAX_PER_RUN } from "./invoice-overdue";
import { lastCompletedDailyDate, lastFinishedRun } from "./job-runs";
import { runScheduled } from "./scheduled";

const bindings = env as unknown as Bindings;
// 09:00 Rome on 2026-06-10 (CEST).
const NOW = new Date("2026-06-10T07:00:00Z");

async function seed(
  id: string,
  over: {
    state?: string;
    due?: string | null;
    paid?: boolean;
    type?: string;
    source?: string;
  } = {},
) {
  await env.DB.prepare(
    `INSERT INTO invoices (id, state, document_type, payment_flag, source, number_raw, due_date,
       client_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'c1', 1)`,
  )
    .bind(
      id,
      over.state ?? "delivered",
      over.type ?? "TD01",
      over.paid ? "paid" : "unpaid",
      over.source ?? "app",
      `${id}/2026`,
      over.due === undefined ? "2026-06-09" : over.due,
    )
    .run();
}
const notes = async () =>
  (
    await env.DB.prepare(
      "SELECT invoice_id AS invoiceId, type, body FROM notifications ORDER BY invoice_id",
    ).all<{ invoiceId: string; type: string; body: string }>()
  ).results;

beforeAll(async () => {
  await applyMigrations(env.DB);
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM job_runs"),
    env.DB.prepare("DELETE FROM invoices"),
    env.DB.prepare("DELETE FROM clients"),
    env.DB.prepare(
      `INSERT INTO clients (id, type, name, country_code, created_at)
       VALUES ('c1', 'it_company', 'Acme S.r.l.', 'IT', 1)`,
    ),
  ]);
});

describe("overdue unpaid invoice notification", () => {
  it("notifies about issued, unpaid invoices past their due date, once each", async () => {
    await seed("a", { state: "delivered", due: "2026-06-09" });
    await seed("b", { state: "sent", due: "2026-01-01" });
    await seed("today", { due: "2026-06-10" });
    await seed("future", { due: "2026-06-30" });
    await seed("nodue", { due: null });
    await seed("paid", { paid: true });
    await seed("credit", { type: "TD04" });
    await seed("unsent", { state: "draft" });
    await seed("rejected", { state: "rejected" });
    await seed("imported", { source: "imported" });
    expect(await notifyOverdueInvoices(bindings, NOW)).toBe(2);
    expect(await notes()).toEqual([
      {
        invoiceId: "a",
        type: "invoice_overdue",
        body: JSON.stringify({ number: "a/2026", client: "Acme S.r.l.", dueDate: "2026-06-09" }),
      },
      {
        invoiceId: "b",
        type: "invoice_overdue",
        body: JSON.stringify({ number: "b/2026", client: "Acme S.r.l.", dueDate: "2026-01-01" }),
      },
    ]);
    // The next run, even on a later day, does not repeat them; a newly overdue one is announced.
    expect(await notifyOverdueInvoices(bindings, new Date("2026-06-11T07:00:00Z"))).toBe(1);
    expect(await notifyOverdueInvoices(bindings, new Date("2026-06-11T08:00:00Z"))).toBe(0);
    expect((await notes()).map((n) => n.invoiceId)).toEqual(["a", "b", "today"]);
  });

  it("stops announcing an invoice once it is paid", async () => {
    await seed("a");
    await env.DB.prepare("UPDATE invoices SET payment_flag = 'paid'").run();
    expect(await notifyOverdueInvoices(bindings, NOW)).toBe(0);
  });

  it("writes a bounded number per run and finishes the backlog the next day", async () => {
    for (let i = 0; i < OVERDUE_MAX_PER_RUN + 3; i += 1) await seed(`i${i}`);
    expect(await notifyOverdueInvoices(bindings, NOW)).toBe(OVERDUE_MAX_PER_RUN);
    expect(await notifyOverdueInvoices(bindings, new Date("2026-06-11T07:00:00Z"))).toBe(3);
  });
});

describe("the daily run", () => {
  const tick = (iso: string) =>
    runScheduled(
      { cron: "*/10 * * * *", scheduledTime: new Date(iso).getTime() } as ScheduledController,
      bindings,
      lastCompletedDailyDate,
    );

  it("runs once per Rome day from 09:00 and records what it did in job_runs", async () => {
    await seed("overdue");
    await seed("unsent", { state: "draft" });
    await env.DB.prepare(
      "UPDATE invoices SET planned_date = '2026-06-10' WHERE id = 'unsent'",
    ).run();
    await tick("2026-06-10T06:50:00Z"); // 08:50 Rome: not yet
    expect(await lastFinishedRun(env.DB, "daily")).toBeNull();
    await tick("2026-06-10T07:00:00Z");
    const run = await lastFinishedRun(env.DB, "daily");
    expect(run).toMatchObject({
      status: "success",
      runDate: "2026-06-10",
      counts: { unsent: 1, overdue: 1 },
    });
    // Later ticks of the same day do nothing.
    await tick("2026-06-10T07:10:00Z");
    await tick("2026-06-10T12:00:00Z");
    const runs = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM job_runs WHERE job = 'daily'",
    ).first<{
      n: number;
    }>();
    expect(runs?.n).toBe(1);
    expect((await notes()).map((n) => n.type).sort()).toEqual(["invoice_due", "invoice_overdue"]);
    // The next day it runs again and reminds about the still unsent invoice only.
    await tick("2026-06-11T07:00:00Z");
    expect((await lastFinishedRun(env.DB, "daily"))?.counts).toMatchObject({
      unsent: 1,
      overdue: 0,
    });
  });
});
