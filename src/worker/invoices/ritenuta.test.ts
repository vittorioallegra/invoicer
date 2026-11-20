import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EMPTY_INVOICE_DATA } from "../../shared/invoice";
import { applyMigrations } from "../auth/test-helpers";
import { dashboardStats, listFilteredInvoices, listInvoices } from "./store";

const NOW = new Date("2026-11-03T10:00:00Z");

/**
 * Invoice "w": 1000.00 net, 22% VAT (total 1220.00), ritenuta 20% of 1000.00 = 200.00, so the
 * client pays 1020.00. Invoice "n": 500.00 net, 22% VAT, no ritenuta (total 610.00).
 */
async function seed(id: string, netCents: number, totalCents: number, ritenuta: boolean) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO invoices (id, document_type, state, state_rank, payment_flag, series_id, year,
         issue_date, planned_date, currency, data, total_cents, created_at)
       VALUES (?1, 'TD01', 'delivered', 4, 'unpaid', 'default', 2026, '2026-10-01', '2026-10-01',
         'EUR', ?2, ?3, ?4)`,
    ).bind(
      id,
      JSON.stringify({
        ...EMPTY_INVOICE_DATA,
        ritenuta: ritenuta ? { type: "RT01", rateBp: 2000, causale: "A" } : null,
      }),
      totalCents,
      Date.now(),
    ),
    env.DB.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, position, description, quantity_milli,
         unit_price_cents, vat_rate_bp) VALUES (?1, ?2, 0, 'Work', 1000, ?3, 2200)`,
    ).bind(`line-${id}`, id, netCents),
  ]);
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seed("w", 100000, 122000, true);
  await seed("n", 50000, 61000, false);
});

describe("ritenuta d'acconto", () => {
  it("leaves the invoiced total whole but takes it off what is left to collect", async () => {
    const { recap, invoices } = await listFilteredInvoices(env.DB, {}, NOW);
    const eur = recap.byCurrency[0];
    // Revenue counts the whole document total; the withholding is only not paid by the client.
    expect(eur?.invoicedCents).toBe(122000 + 61000);
    expect(eur?.toCollectCents).toBe(122000 - 20000 + 61000);
    const ritenuta = Object.fromEntries(invoices.map((i) => [i.id, i.ritenutaCents]));
    expect(ritenuta).toEqual({ w: 20000, n: 0 });
  });

  it("gives the Home to-send list the same VAT and ritenuta as the Invoices list", async () => {
    await env.DB.prepare("UPDATE invoices SET state = 'draft' WHERE id IN ('w', 'n')").run();
    const rows = await listInvoices(env.DB, "to_issue", NOW);
    const by = Object.fromEntries(rows.map((r) => [r.id, [r.vatCents, r.ritenutaCents]]));
    expect(by).toEqual({ w: [22000, 20000], n: [11000, 0] });
    await env.DB.prepare("UPDATE invoices SET state = 'delivered' WHERE id IN ('w', 'n')").run();
  });

  it("gives Home the same figures", async () => {
    const stats = await dashboardStats(env.DB, NOW);
    expect(stats.year[0]?.invoicedCents).toBe(183000);
    expect(stats.toCollectCents).toBe(163000);
    expect(stats.toCollectCount).toBe(2);
    expect(stats.monthly[9]?.currentCents).toBe(183000);
  });
});
