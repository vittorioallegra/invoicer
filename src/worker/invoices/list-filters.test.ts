import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../auth/test-helpers";
import { listFilteredInvoices } from "./store";

const NOW = new Date("2026-11-03T10:00:00Z");

interface Seed {
  id: string;
  type?: "TD01" | "TD04";
  state: string;
  paid?: boolean;
  client?: string;
  series?: string;
  number?: number;
  issue?: string;
  planned?: string;
  currency?: string;
  total: number | null;
}

const insert = (s: Seed) =>
  env.DB.prepare(
    `INSERT INTO invoices (id, document_type, state, state_rank, payment_flag, client_id, number_raw,
       number_int, series_id, year, issue_date, planned_date, currency, total_cents, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      s.id,
      s.type ?? "TD01",
      s.state,
      s.paid ? "paid" : "unpaid",
      s.client ?? null,
      s.number === undefined ? null : `${s.number}/${s.series === "b" ? "B" : "A"}`,
      s.number ?? null,
      s.series ?? "default",
      s.issue ? Number(s.issue.slice(0, 4)) : null,
      s.issue ?? null,
      s.planned ?? null,
      s.currency ?? "EUR",
      s.total,
      Date.now(),
    )
    .run();

const ids = (r: Awaited<ReturnType<typeof listFilteredInvoices>>) => r.invoices.map((i) => i.id);

beforeAll(async () => {
  await applyMigrations(env.DB);
  for (const [id, name] of [
    ["c1", "Acme S.r.l."],
    ["c2", "Beta 100%"],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO clients (id, type, name, country_code, created_at) VALUES (?, 'it_company', ?, 'IT', ?)",
    )
      .bind(id, name, Date.now())
      .run();
  }
  await insert({
    id: "a",
    state: "delivered",
    client: "c1",
    number: 1,
    issue: "2026-02-01",
    total: 100000,
  });
  await insert({
    id: "b",
    state: "sent",
    client: "c1",
    number: 2,
    issue: "2026-03-01",
    paid: true,
    total: 20000,
  });
  await insert({
    id: "cn",
    type: "TD04",
    state: "delivered",
    client: "c1",
    number: 3,
    issue: "2026-04-01",
    total: 30000,
  });
  await insert({
    id: "rej",
    state: "rejected",
    client: "c2",
    number: 4,
    issue: "2026-05-01",
    total: 50000,
  });
  await insert({
    id: "usd",
    state: "delivered",
    client: "c2",
    number: 5,
    issue: "2026-06-01",
    currency: "USD",
    total: 7000,
  });
  await insert({ id: "d1", state: "draft", client: "c2", total: 4000 });
  await insert({ id: "p1", state: "planned", client: "c1", planned: "2026-12-01", total: 1000 });
  await insert({
    id: "old",
    state: "delivered",
    client: "c1",
    series: "b",
    number: 1,
    issue: "2025-12-31",
    total: 9900,
  });
});

describe("listFilteredInvoices", () => {
  it("defaults to the current Rome year, newest first, undated unsent invoices first", async () => {
    const result = await listFilteredInvoices(env.DB, {}, NOW);
    // d1 has no date and counts as today; p1 is planned in December.
    expect(ids(result)).toEqual(["p1", "d1", "usd", "rej", "cn", "b", "a"]);
  });

  it("recaps the filtered set: credit notes subtracted, rejected excluded, per currency", async () => {
    const { recap } = await listFilteredInvoices(env.DB, {}, NOW);
    expect(recap.count).toBe(7);
    expect(recap.toSendCount).toBe(2);
    // EUR invoiced: 100000 + 20000 - 30000 (rejected 50000 left out); to collect: 100000 - 30000.
    expect(recap.byCurrency).toEqual([
      { currency: "EUR", invoicedCents: 90000, toCollectCents: 70000, toSendCents: 5000 },
      { currency: "USD", invoicedCents: 7000, toCollectCents: 7000, toSendCents: 0 },
    ]);
  });

  it("lists the years that have invoices, newest first", async () => {
    expect((await listFilteredInvoices(env.DB, {}, NOW)).years).toEqual([2026, 2025]);
  });

  it("reaches other years with year=all or a year, and recaps only what is shown", async () => {
    expect(ids(await listFilteredInvoices(env.DB, { year: "2025" }, NOW))).toEqual(["old"]);
    const all = await listFilteredInvoices(env.DB, { year: "all" }, NOW);
    expect(all.invoices).toHaveLength(8);
    expect(all.recap.byCurrency[0]?.invoicedCents).toBe(99900);
  });

  it("filters by status, mapping paid and unpaid onto the payment flag of finalised invoices", async () => {
    const pick = async (
      status: "to_send" | "in_progress" | "delivered" | "rejected" | "paid" | "unpaid",
    ) => ids(await listFilteredInvoices(env.DB, { status }, NOW)).sort();
    expect(await pick("to_send")).toEqual(["d1", "p1"]);
    expect(await pick("in_progress")).toEqual(["b"]);
    expect(await pick("delivered")).toEqual(["a", "cn", "usd"]);
    expect(await pick("rejected")).toEqual(["rej"]);
    expect(await pick("paid")).toEqual(["b"]);
    expect(await pick("unpaid")).toEqual(["a", "cn", "usd"]);
  });

  it("filters by client and series", async () => {
    expect(ids(await listFilteredInvoices(env.DB, { client: "c2" }, NOW)).sort()).toEqual([
      "d1",
      "rej",
      "usd",
    ]);
    expect(ids(await listFilteredInvoices(env.DB, { year: "all", series: "b" }, NOW))).toEqual([
      "old",
    ]);
  });

  it("lists EUR with zeros when nothing matches", async () => {
    const empty = await listFilteredInvoices(env.DB, { client: "nobody" }, NOW);
    expect(empty.invoices).toEqual([]);
    expect(empty.recap).toEqual({
      count: 0,
      toSendCount: 0,
      byCurrency: [{ currency: "EUR", invoicedCents: 0, toCollectCents: 0, toSendCents: 0 }],
    });
  });
});
