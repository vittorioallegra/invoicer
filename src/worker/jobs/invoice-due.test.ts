import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../auth/test-helpers";
import type { Bindings } from "../env";
import { INVOICE_DUE_REMINDER_DAYS, remindUnsentInvoices } from "./invoice-due";

const bindings = env as unknown as Bindings;
// 09:00 Rome on 2026-06-10 (CEST).
const NOW = new Date("2026-06-10T07:00:00Z");

async function seed(id: string, over: { state?: string; date?: string | null } = {}) {
  await env.DB.prepare(
    `INSERT INTO invoices (id, state, planned_date, client_id, created_at)
     VALUES (?, ?, ?, 'c1', 1)`,
  )
    .bind(id, over.state ?? "draft", over.date === undefined ? "2026-06-10" : over.date)
    .run();
}
const notes = async () =>
  (
    await env.DB.prepare(
      "SELECT invoice_id AS invoiceId, type, title, body FROM notifications ORDER BY invoice_id",
    ).all<{ invoiceId: string; type: string; title: string; body: string }>()
  ).results;

beforeAll(async () => {
  await applyMigrations(env.DB);
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM invoices"),
    env.DB.prepare("DELETE FROM clients"),
    env.DB.prepare(
      `INSERT INTO clients (id, type, name, country_code, created_at)
       VALUES ('c1', 'it_company', 'Acme S.r.l.', 'IT', 1)`,
    ),
  ]);
});

describe("unsent invoice reminder", () => {
  it("reminds about any unsent invoice whose date has arrived, planned or not", async () => {
    await seed("a", { state: "draft", date: "2026-06-10" });
    await seed("b", { state: "planned", date: "2026-06-08" });
    await seed("c", { state: "draft", date: "2026-06-11" });
    await seed("d", { state: "draft", date: null });
    await seed("e", { state: "sent", date: "2026-06-09" });
    expect(await remindUnsentInvoices(bindings, NOW)).toBe(2);
    expect(await notes()).toEqual([
      {
        invoiceId: "a",
        type: "invoice_due",
        title: "notifications.invoice_due.title",
        body: JSON.stringify({ client: "Acme S.r.l.", date: "2026-06-10", day: "2026-06-10" }),
      },
      {
        invoiceId: "b",
        type: "invoice_due",
        title: "notifications.invoice_due.title",
        body: JSON.stringify({ client: "Acme S.r.l.", date: "2026-06-08", day: "2026-06-10" }),
      },
    ]);
  });

  it("is idempotent within a day and repeats on the next day", async () => {
    await seed("a");
    expect(await remindUnsentInvoices(bindings, NOW)).toBe(1);
    expect(await remindUnsentInvoices(bindings, NOW)).toBe(0);
    expect(await notes()).toHaveLength(1);
    expect(await remindUnsentInvoices(bindings, new Date("2026-06-11T07:00:00Z"))).toBe(1);
    expect(await notes()).toHaveLength(2);
  });

  it("stops after the sensible limit and once the invoice is sent", async () => {
    await seed("old", { date: "2026-05-20" });
    expect(INVOICE_DUE_REMINDER_DAYS).toBe(14);
    expect(await remindUnsentInvoices(bindings, NOW)).toBe(0);
    await seed("edge", { date: "2026-05-27" });
    expect(await remindUnsentInvoices(bindings, NOW)).toBe(1);
    await env.DB.prepare("UPDATE invoices SET state = 'sending' WHERE id = 'edge'").run();
    expect(await remindUnsentInvoices(bindings, new Date("2026-06-11T07:00:00Z"))).toBe(0);
  });
});
