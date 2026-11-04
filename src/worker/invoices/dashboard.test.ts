import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../auth/test-helpers";
import { dashboardStats, listFilteredInvoices } from "./store";

const NOW = new Date("2026-11-03T10:00:00Z");

interface Seed {
  id: string;
  type?: "TD01" | "TD04";
  state: string;
  paid?: boolean;
  issue?: string;
  planned?: string;
  due?: string;
  currency?: string;
  total: number | null;
}

const insert = (s: Seed) =>
  env.DB.prepare(
    `INSERT INTO invoices (id, document_type, state, state_rank, payment_flag, series_id, year,
       issue_date, planned_date, due_date, currency, total_cents, created_at)
     VALUES (?, ?, ?, 0, ?, 'default', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      s.id,
      s.type ?? "TD01",
      s.state,
      s.paid ? "paid" : "unpaid",
      s.issue ? Number(s.issue.slice(0, 4)) : null,
      s.issue ?? null,
      s.planned ?? null,
      s.due ?? null,
      s.currency ?? "EUR",
      s.total,
      Date.now(),
    )
    .run();

beforeAll(async () => {
  await applyMigrations(env.DB);
  // This month: 1000 EUR invoiced, minus a 250 credit note; one USD invoice.
  await insert({
    id: "m1",
    state: "delivered",
    issue: "2026-11-02",
    due: "2026-12-02",
    total: 100000,
  });
  await insert({ id: "m2", type: "TD04", state: "delivered", issue: "2026-11-03", total: 25000 });
  await insert({ id: "usd", state: "sent", issue: "2026-11-01", currency: "USD", total: 7000 });
  // Earlier this year: overdue unpaid, overdue but paid, not yet due.
  await insert({
    id: "o1",
    state: "delivered",
    issue: "2026-03-01",
    due: "2026-03-31",
    total: 50000,
  });
  await insert({
    id: "o2",
    state: "sent",
    issue: "2026-04-01",
    due: "2026-04-30",
    paid: true,
    total: 30000,
  });
  await insert({
    id: "o3",
    state: "not_delivered",
    issue: "2026-05-01",
    due: "2026-11-03",
    total: 1000,
  });
  // Last year: counts in neither period, but is overdue.
  await insert({
    id: "old",
    state: "delivered",
    issue: "2025-12-01",
    due: "2025-12-31",
    total: 9900,
  });
  // Rejected and unsent invoices are not invoiced; an overdue date on them does not count.
  await insert({
    id: "rej",
    state: "rejected",
    issue: "2026-11-01",
    due: "2026-11-02",
    total: 80000,
  });
  await insert({ id: "d1", state: "draft", total: 4000 });
  await insert({ id: "p1", state: "planned", planned: "2026-11-20", total: 1000 });
});

describe("dashboardStats", () => {
  it("counts what needs attention", async () => {
    const stats = await dashboardStats(env.DB, NOW);
    expect(stats.today).toBe("2026-11-03");
    expect(stats.toSendCount).toBe(2);
    expect(stats.rejectedCount).toBe(1);
    // o1 and old are past due and unpaid; o2 is paid; o3 is due today, not past; the credit note has no due date.
    expect(stats.overdueCount).toBe(2);
  });

  it("totals the year and the month in cents, credit notes subtracted, EUR first", async () => {
    const stats = await dashboardStats(env.DB, NOW);
    expect(stats.month).toEqual([
      { currency: "EUR", invoicedCents: 75000 },
      { currency: "USD", invoicedCents: 7000 },
    ]);
    // 100000 - 25000 + 50000 + 30000 + 1000; last year and the rejected invoice are left out.
    expect(stats.year).toEqual([
      { currency: "EUR", invoicedCents: 156000 },
      { currency: "USD", invoicedCents: 7000 },
    ]);
  });

  it("lists EUR with zero when nothing is invoiced in the period", async () => {
    const stats = await dashboardStats(env.DB, new Date("2027-02-10T10:00:00Z"));
    expect(stats.month).toEqual([{ currency: "EUR", invoicedCents: 0 }]);
    expect(stats.year).toEqual([{ currency: "EUR", invoicedCents: 0 }]);
  });
});

describe("overdue status filter", () => {
  it("lists the unpaid, finalised invoices past their due date, the same set as the count", async () => {
    const result = await listFilteredInvoices(env.DB, { status: "overdue", year: "all" }, NOW);
    expect(result.invoices.map((i) => i.id).sort()).toEqual(["o1", "old"]);
    expect(result.invoices.every((i) => i.paymentFlag === "overdue")).toBe(true);
  });
});
