import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_INVOICE_DATA } from "../../shared/invoice";
import type { RecurringSchedule } from "../../shared/recurring";
import { applyMigrations } from "../auth/test-helpers";
import type { Bindings } from "../env";
import { deleteInvoice } from "../invoices/store";
import {
  createTemplateFromInvoice,
  deleteTemplate,
  setTemplatePaused,
  updateTemplateSchedule,
} from "../recurring";
import { createRecurringInvoices, RECURRING_MAX_PER_RUN } from "./recurring";

const bindings = env as unknown as Bindings;
/** 09:00 Rome (07:00 or 08:00 UTC) on a date. */
const at = (date: string, hour = 7) => new Date(`${date}T0${hour}:00:00Z`);

const lines = [
  {
    description: "Retainer",
    note: "",
    quantityMilli: 1000,
    unit: null,
    unitPriceCents: 100_000,
    vatRateBp: 2200,
    natura: null,
  },
];
const content = {
  currency: "EUR",
  seriesId: null,
  lines,
  data: {
    ...EMPTY_INVOICE_DATA,
    payment: { ...EMPTY_INVOICE_DATA.payment, terms: { kind: "custom", days: 30 } },
  },
};

async function seedTemplate(
  id: string,
  schedule: Partial<RecurringSchedule> & { paused?: boolean } = {},
) {
  await env.DB.prepare(
    `INSERT INTO recurring_templates
       (id, client_id, body, interval_months, day_of_month, start_date, end_date, max_count, paused, created_at)
     VALUES (?, 'c1', ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(
      id,
      JSON.stringify(content),
      schedule.intervalMonths ?? 1,
      schedule.dayOfMonth ?? 1,
      schedule.startDate ?? "2026-01-01",
      schedule.endDate ?? null,
      schedule.maxCount ?? null,
      schedule.paused ? 1 : 0,
    )
    .run();
}
const invoices = async () =>
  (
    await env.DB.prepare(
      `SELECT id, state, planned_date AS date, due_date AS due, total_cents AS total, number_int AS number,
              recurring_template_id AS template
       FROM invoices ORDER BY planned_date, id`,
    ).all<{
      id: string;
      state: string;
      date: string;
      due: string | null;
      total: number | null;
      number: number | null;
      template: string | null;
    }>()
  ).results;
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

beforeAll(async () => {
  await applyMigrations(env.DB);
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM recurring_occurrences"),
    env.DB.prepare("DELETE FROM invoice_lines"),
    env.DB.prepare("DELETE FROM invoices"),
    env.DB.prepare("DELETE FROM recurring_templates"),
    env.DB.prepare("DELETE FROM clients"),
    env.DB.prepare("DELETE FROM settings"),
    env.DB.prepare(
      `INSERT INTO clients (id, type, name, country_code, created_at)
       VALUES ('c1', 'it_company', 'Acme S.r.l.', 'IT', 1)`,
    ),
  ]);
});

describe("recurring invoices (AC 12)", () => {
  it("creates exactly one to-send invoice per month across 12 months, running the job twice a day", async () => {
    await seedTemplate("t1", { startDate: "2026-01-01" });
    // Daily from 2025-12-29 (3 days before the first occurrence) to the end of 2026, two runs a day.
    const start = new Date("2025-12-29T07:00:00Z").getTime();
    for (let day = 0; day < 370; day += 1) {
      const now = new Date(start + day * 86_400_000);
      await createRecurringInvoices(bindings, now);
      await createRecurringInvoices(bindings, new Date(now.getTime() + 600_000));
    }
    const all = await invoices();
    const leadIntoNextYear = all.filter((row) => row.date >= "2027-01-01");
    expect(all.filter((row) => row.date <= "2026-12-31").map((row) => row.date)).toEqual(
      Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}-01`),
    );
    // The run on 2026-12-29 already made 2027-01-01 (lead time); nothing extra.
    expect(leadIntoNextYear.length).toBeGreaterThanOrEqual(1);
    expect(new Set(all.map((row) => row.date)).size).toBe(all.length);
    expect(await count("recurring_occurrences")).toBe(all.length);
    expect(await count("notifications")).toBe(all.length);
  });

  it("creates a normal unsent invoice: no number, never sent, due date from the terms", async () => {
    await seedTemplate("t1", { startDate: "2026-06-01" });
    expect(await createRecurringInvoices(bindings, at("2026-05-29"))).toBe(1);
    const [row] = await invoices();
    expect(row).toMatchObject({
      date: "2026-06-01",
      due: "2026-07-01",
      total: 122_000,
      number: null,
      template: "t1",
      state: "planned",
    });
    // The date has arrived: a draft would show as To send as well.
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM transmissions").first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(
      await env.DB.prepare("SELECT body, invoice_id AS invoiceId, type FROM notifications").first(),
    ).toMatchObject({
      type: "recurring_created",
      body: JSON.stringify({ client: "Acme S.r.l.", date: "2026-06-01" }),
      invoiceId: row?.id,
    });
    expect(await count("invoice_lines")).toBe(1);
  });

  it("waits for the lead time, which is configurable", async () => {
    await seedTemplate("t1", { startDate: "2026-06-10", dayOfMonth: 10 });
    expect(await createRecurringInvoices(bindings, at("2026-06-06"))).toBe(0);
    expect(await createRecurringInvoices(bindings, at("2026-06-07"))).toBe(1);
    await env.DB.prepare("DELETE FROM recurring_occurrences").run();
    await env.DB.prepare("DELETE FROM invoice_lines").run();
    await env.DB.prepare("DELETE FROM notifications").run();
    await env.DB.prepare("DELETE FROM invoices").run();
    await env.DB.prepare(
      "INSERT INTO settings (id, recurring_lead_days) VALUES (1, 10) ON CONFLICT(id) DO UPDATE SET recurring_lead_days = 10",
    ).run();
    expect(await createRecurringInvoices(bindings, at("2026-05-31"))).toBe(1);
  });

  it("catches up occurrences missed during downtime, once", async () => {
    await seedTemplate("t1", { startDate: "2026-01-01" });
    await createRecurringInvoices(bindings, at("2026-01-02"));
    // The job did not run for two months.
    expect(await createRecurringInvoices(bindings, at("2026-03-02"))).toBe(2);
    expect(await createRecurringInvoices(bindings, at("2026-03-02"))).toBe(0);
    expect((await invoices()).map((row) => row.date)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
  });

  it("does not create an occurrence twice when two runs race", async () => {
    await seedTemplate("t1", { startDate: "2026-06-01" });
    const runs = await Promise.all([
      createRecurringInvoices(bindings, at("2026-06-01")),
      createRecurringInvoices(bindings, at("2026-06-01")),
    ]);
    expect(runs.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await count("invoices")).toBe(1);
    expect(await count("notifications")).toBe(1);
  });

  it("stops at the end date and at the invoice count", async () => {
    await seedTemplate("ends", { startDate: "2026-01-01", endDate: "2026-02-15" });
    await seedTemplate("counted", { startDate: "2026-01-01", maxCount: 2 });
    await createRecurringInvoices(bindings, at("2026-05-01"));
    const all = await invoices();
    expect(all.filter((row) => row.template === "ends").map((row) => row.date)).toEqual([
      "2026-01-01",
      "2026-02-01",
    ]);
    expect(all.filter((row) => row.template === "counted")).toHaveLength(2);
  });

  it("skips a paused template and does not make up the paused months on resume", async () => {
    await seedTemplate("t1", { startDate: "2026-01-01", paused: true });
    expect(await createRecurringInvoices(bindings, at("2026-03-15"))).toBe(0);
    await setTemplatePaused(bindings.DB, "t1", false, at("2026-03-15"));
    expect(await createRecurringInvoices(bindings, at("2026-03-15"))).toBe(0);
    expect(await createRecurringInvoices(bindings, at("2026-03-29"))).toBe(1);
    expect((await invoices()).map((row) => row.date)).toEqual(["2026-04-01"]);
  });

  it("applies an edited schedule to future occurrences only", async () => {
    await seedTemplate("t1", { startDate: "2026-01-01" });
    await createRecurringInvoices(bindings, at("2026-03-02")); // Jan, Feb, Mar created
    const schedule = {
      intervalMonths: 1,
      dayOfMonth: 15,
      startDate: "2026-01-01",
      endDate: null,
      maxCount: null,
    };
    await updateTemplateSchedule(bindings.DB, "t1", schedule, at("2026-03-20"));
    // Past dates (e.g. 15 January, February, March) are not created retroactively.
    await createRecurringInvoices(bindings, at("2026-03-20"));
    expect((await invoices()).map((row) => row.date)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
    await createRecurringInvoices(bindings, at("2026-04-12"));
    expect((await invoices()).at(-1)?.date).toBe("2026-04-15");
  });

  it("does not recreate a deleted occurrence, and a deleted template keeps its invoices", async () => {
    await seedTemplate("t1", { startDate: "2026-06-01" });
    await createRecurringInvoices(bindings, at("2026-06-01"));
    const [row] = await invoices();
    await deleteInvoice(bindings.DB, row?.id as string);
    expect(await count("invoices")).toBe(0);
    expect(await count("notifications")).toBe(0);
    expect(await createRecurringInvoices(bindings, at("2026-06-01"))).toBe(0);
    expect(await createRecurringInvoices(bindings, at("2026-06-28"))).toBe(1);
    await deleteTemplate(bindings.DB, "t1");
    expect(await count("invoices")).toBe(1);
    expect((await invoices())[0]?.template).toBeNull();
    expect(await count("recurring_occurrences")).toBe(0);
  });

  it("creates at most a bounded number per run and continues the next day", async () => {
    await seedTemplate("t1", { startDate: "2020-01-01" });
    await createRecurringInvoices(bindings, at("2020-01-01"));
    await env.DB.prepare("DELETE FROM recurring_occurrences").run();
    await env.DB.prepare("DELETE FROM invoice_lines").run();
    await env.DB.prepare("DELETE FROM notifications").run();
    await env.DB.prepare("DELETE FROM invoices").run();
    // Six years of monthly occurrences are due at once.
    expect(await createRecurringInvoices(bindings, at("2026-01-01"))).toBe(RECURRING_MAX_PER_RUN);
    expect(await createRecurringInvoices(bindings, at("2026-01-02"))).toBe(
      73 - RECURRING_MAX_PER_RUN,
    );
  });

  it("starts a template made from an invoice today, copying its content", async () => {
    await env.DB.prepare(
      `INSERT INTO invoices (id, state, document_type, source, client_id, currency, data, created_at)
       VALUES ('src', 'delivered', 'TD01', 'app', 'c1', 'EUR', ?, 1)`,
    )
      .bind(JSON.stringify(content.data))
      .run();
    await env.DB.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, position, description, quantity_milli, unit_price_cents, vat_rate_bp)
       VALUES ('l1', 'src', 0, 'Retainer', 1000, 100000, 2200)`,
    ).run();
    const id = await createTemplateFromInvoice(
      bindings.DB,
      "src",
      { intervalMonths: 1, dayOfMonth: 1, startDate: "2026-01-01", endDate: null, maxCount: null },
      at("2026-06-10"),
    );
    // The months before today are skipped, the next one is made when its lead time arrives.
    expect(await createRecurringInvoices(bindings, at("2026-06-10"))).toBe(0);
    expect(await createRecurringInvoices(bindings, at("2026-06-29"))).toBe(1);
    const created = (await invoices()).find((row) => row.template === id);
    expect(created).toMatchObject({ date: "2026-07-01", total: 122_000 });
    await expect(
      createTemplateFromInvoice(
        bindings.DB,
        "missing",
        {
          intervalMonths: 1,
          dayOfMonth: 1,
          startDate: "2026-01-01",
          endDate: null,
          maxCount: null,
        },
        at("2026-06-10"),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
