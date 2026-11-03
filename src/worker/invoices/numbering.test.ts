import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeFileProgressive } from "../../shared/fatturapa/file-name";
import { EMPTY_INVOICE_DATA } from "../../shared/invoice";
import { applyMigrations } from "../auth/test-helpers";
import { addTransmissionAttempt, nextFreeNumber, releaseNumber, reserveNumber } from "./numbering";

const db = env.DB;
const ISSUER = { idPaese: "IT", idCodice: "12345678903" };
const at = (iso: string) => new Date(iso);

let counter = 0;

/** Inserts a bare invoice row; tests control state, number and dates directly. */
async function insertInvoice(
  fields: {
    state?: string;
    source?: "app" | "imported";
    year?: number;
    number?: number;
    issueDate?: string;
    invoiceDate?: string;
    requested?: number;
    series?: string;
    dueDate?: string;
    data?: unknown;
  } = {},
): Promise<string> {
  const id = `inv-${++counter}`;
  const states = [
    "draft",
    "planned",
    "sending",
    "sent",
    "delivered",
    "not_delivered",
    "rejected",
    "rejected_expired",
  ];
  const state = fields.state ?? "draft";
  await db
    .prepare(
      `INSERT INTO invoices (id, state, state_rank, source, year, number_int, number_raw, issue_date,
         planned_date, requested_number_int, created_at, due_date, data, series_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      state,
      states.indexOf(state),
      fields.source ?? "app",
      fields.year ?? null,
      fields.number ?? null,
      fields.number === undefined ? null : String(fields.number),
      fields.issueDate ?? null,
      fields.invoiceDate ?? null,
      fields.requested ?? null,
      Date.now(),
      fields.dueDate ?? null,
      fields.data === undefined ? null : JSON.stringify(fields.data),
      fields.series ?? "default",
    )
    .run();
  return id;
}

const sequenceOf = async (year: number, series = "default") =>
  (
    await db
      .prepare("SELECT last_number FROM number_sequences WHERE year = ? AND series_id = ?")
      .bind(year, series)
      .first<{ last_number: number }>()
  )?.last_number ?? null;

const fileSequence = async () =>
  (
    await db.prepare("SELECT last_value FROM file_sequence WHERE id = 1").first<{
      last_value: number;
    }>()
  )?.last_value ?? 0;

const reserve = (invoiceId: string, now: string) =>
  reserveNumber(db, { invoiceId, now: at(now), ...ISSUER });

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { code?: string; problem?: { detail?: string } }) => ({
      code: error.code,
      detail: error.problem?.detail,
    }),
  );

beforeAll(() => applyMigrations(db));

describe("number reservation", () => {
  it("numbers invoices one after the other and allocates the file progressive", async () => {
    const first = await reserve(await insertInvoice(), "2030-03-10T10:00:00Z");
    const second = await reserve(await insertInvoice(), "2030-03-10T11:00:00Z");
    expect([first.number, second.number]).toEqual([1, 2]);
    expect(first.year).toBe(2030);
    expect(first.issueDate).toBe("2030-03-10");
    expect(first.transmission.fileName).toBe(
      `IT12345678903_${encodeFileProgressive(first.transmission.fileProgressive)}.xml`,
    );
    expect(second.transmission.fileProgressive).toBe(first.transmission.fileProgressive + 1);
    const row = await db
      .prepare("SELECT state, state_rank FROM invoices WHERE id = ?")
      .bind(first.invoiceId)
      .first();
    expect(row).toEqual({ state: "sending", state_rank: 2 });
  });

  it("gives two devices reserving the same invoice one number and one transmission", async () => {
    const id = await insertInvoice();
    const results = await Promise.all([
      reserve(id, "2031-02-01T09:00:00Z"),
      reserve(id, "2031-02-01T09:00:00Z"),
      reserve(id, "2031-02-01T09:00:00Z"),
    ]);
    expect(new Set(results.map((r) => r.number)).size).toBe(1);
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    expect(await sequenceOf(2031)).toBe(1);
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM transmissions WHERE invoice_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("never repeats a number across concurrent sends of different invoices", async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => insertInvoice()));
    const progressiveBefore = await fileSequence();
    const results = await Promise.all(ids.map((id) => reserve(id, "2032-05-05T08:00:00Z")));
    expect(results.map((r) => r.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await fileSequence()).toBe(progressiveBefore + 6);
  });

  it("continues after the highest imported number", async () => {
    await insertInvoice({ state: "delivered", source: "imported", year: 2033, number: 41 });
    const result = await reserve(await insertInvoice(), "2033-06-01T10:00:00Z");
    expect(result.number).toBe(42);
  });

  it("ignores a value left in the year's sequence row: only issued numbers count", async () => {
    await db
      .prepare(
        "INSERT INTO number_sequences (series_id, year, last_number) VALUES ('default', 2034, 99)",
      )
      .run();
    await insertInvoice({ state: "delivered", source: "imported", year: 2034, number: 3 });
    const result = await reserve(await insertInvoice(), "2034-06-01T10:00:00Z");
    expect(result.number).toBe(4);
  });

  it("counts app and imported numbers of the year, and only that year", async () => {
    await insertInvoice({ state: "delivered", source: "imported", year: 2035, number: 10 });
    await insertInvoice({ state: "delivered", source: "app", year: 2035, number: 7 });
    await insertInvoice({ state: "delivered", source: "imported", year: 2034, number: 500 });
    expect(await nextFreeNumber(db, 2035, "default")).toBe(11);
    expect(await nextFreeNumber(db, 2099, "default")).toBe(1);
    expect((await reserve(await insertInvoice(), "2035-06-01T10:00:00Z")).number).toBe(11);
  });

  it("leaves every sequence unchanged when the guard fails", async () => {
    await db
      .prepare(
        "INSERT INTO number_sequences (series_id, year, last_number) VALUES ('default', 2036, 4)",
      )
      .run();
    const locked = await insertInvoice({ state: "delivered" });
    const progressive = await fileSequence();
    expect(await failure(reserve(locked, "2036-02-02T10:00:00Z"))).toMatchObject({
      code: "conflict",
      detail: "invoice_locked",
    });
    expect(await failure(reserve("missing", "2036-02-02T10:00:00Z"))).toMatchObject({
      code: "not_found",
    });
    expect(await sequenceOf(2036)).toBe(4);
    expect(await fileSequence()).toBe(progressive);
    const row = await db
      .prepare("SELECT state, number_int FROM invoices WHERE id = ?")
      .bind(locked)
      .first();
    expect(row).toEqual({ state: "delivered", number_int: null });
  });

  it("does not create the year's sequence row when the guard fails", async () => {
    const locked = await insertInvoice({ state: "sent" });
    await failure(reserve(locked, "2037-02-02T10:00:00Z"));
    expect(await sequenceOf(2037)).toBeNull();
  });

  it("takes year and date from Europe/Rome, not UTC", async () => {
    // 23:30 UTC on New Year's Eve is already 00:30 on 1 January in Rome (CET, UTC+1).
    const newYear = await reserve(await insertInvoice(), "2038-12-31T23:30:00Z");
    expect([newYear.year, newYear.issueDate]).toEqual([2039, "2039-01-01"]);
    // 22:30 UTC on the same day is 23:30 in Rome: still the old year.
    const eve = await reserve(await insertInvoice(), "2038-12-31T22:30:00Z");
    expect([eve.year, eve.issueDate]).toEqual([2038, "2038-12-31"]);
    // Summer time (CEST, UTC+2): 22:30 UTC on 30 June is 00:30 on 1 July.
    const summer = await reserve(await insertInvoice(), "2045-06-30T22:30:00Z");
    expect(summer.issueDate).toBe("2045-07-01");
  });

  it("uses the invoice date as issue date and numbering year when it is not in the future", async () => {
    const past = await reserve(
      await insertInvoice({ state: "planned", invoiceDate: "2060-12-30" }),
      "2061-01-08T10:00:00Z",
    );
    expect([past.year, past.issueDate, past.number]).toEqual([2060, "2060-12-30", 1]);
    // A date in the future means the day it is sent.
    const future = await reserve(
      await insertInvoice({ state: "planned", invoiceDate: "2061-02-01" }),
      "2061-01-09T10:00:00Z",
    );
    expect([future.year, future.issueDate]).toEqual([2061, "2061-01-09"]);
  });

  it("refuses an issue date earlier than the highest number of the year", async () => {
    await insertInvoice({ state: "sent", year: 2040, number: 5, issueDate: "2040-05-10" });
    const late = await insertInvoice();
    expect(await failure(reserve(late, "2040-05-09T10:00:00Z"))).toMatchObject({
      code: "conflict",
      detail: expect.stringContaining("date_before_last_issue"),
    });
    expect(await sequenceOf(2040)).toBeNull();
    expect((await reserve(late, "2040-05-10T10:00:00Z")).number).toBe(6);
  });
});

describe("due date from the payment terms", () => {
  const payment = (terms: unknown, dueDateCustom = false) => ({
    ...EMPTY_INVOICE_DATA,
    payment: { ...EMPTY_INVOICE_DATA.payment, terms, dueDateCustom },
  });
  const dueOf = async (id: string) =>
    (
      await db.prepare("SELECT due_date FROM invoices WHERE id = ?").bind(id).first<{
        due_date: string | null;
      }>()
    )?.due_date;

  it("recomputes the due date from the issue date when the number is reserved", async () => {
    const id = await insertInvoice({
      dueDate: "2070-01-01",
      data: payment({ kind: "eom_30" }),
    });
    const reservation = await reserve(id, "2070-11-10T10:00:00Z");
    expect(reservation.issueDate).toBe("2070-11-10");
    expect(await dueOf(id)).toBe("2070-12-31");

    const plain = await insertInvoice({ data: payment({ kind: "custom", days: 60 }) });
    await reserve(plain, "2070-11-10T11:00:00Z");
    expect(await dueOf(plain)).toBe("2071-01-09");
  });

  it("uses the Rome date, not the UTC one", async () => {
    const id = await insertInvoice({ data: payment({ kind: "invoice_date" }) });
    await reserve(id, "2070-12-31T23:30:00Z");
    expect(await dueOf(id)).toBe("2071-01-01");
  });

  it("keeps a due date set by hand and an invoice without terms as stored", async () => {
    const custom = await insertInvoice({
      dueDate: "2070-12-24",
      data: payment({ kind: "custom", days: 30 }, true),
    });
    await reserve(custom, "2070-11-11T10:00:00Z");
    expect(await dueOf(custom)).toBe("2070-12-24");

    const none = await insertInvoice({ dueDate: "2070-12-25", data: payment(null) });
    await reserve(none, "2070-11-11T11:00:00Z");
    expect(await dueOf(none)).toBe("2070-12-25");

    const bare = await insertInvoice({ dueDate: "2070-12-26" });
    await reserve(bare, "2070-11-11T12:00:00Z");
    expect(await dueOf(bare)).toBe("2070-12-26");
  });
});

describe("requested numbers", () => {
  it("accepts a requested number above the highest, also leaving a gap", async () => {
    await insertInvoice({ state: "delivered", source: "imported", year: 2060, number: 3 });
    const id = await insertInvoice({ requested: 120 });
    const result = await reserve(id, "2060-04-01T10:00:00Z");
    expect(result.number).toBe(120);
    const row = await db
      .prepare("SELECT number_raw, requested_number_int FROM invoices WHERE id = ?")
      .bind(id)
      .first();
    expect(row).toEqual({ number_raw: "120", requested_number_int: null });
    expect(await nextFreeNumber(db, 2060, "default")).toBe(121);
    // Later invoices continue automatically from the highest issued number.
    expect((await reserve(await insertInvoice(), "2060-04-02T10:00:00Z")).number).toBe(121);
  });

  it("accepts the number that equals the proposal", async () => {
    await insertInvoice({ state: "delivered", source: "app", year: 2061, number: 4 });
    const result = await reserve(await insertInvoice({ requested: 5 }), "2061-04-01T10:00:00Z");
    expect(result.number).toBe(5);
  });

  it("refuses a number equal to or below the highest, counting imported ones, and changes nothing", async () => {
    await insertInvoice({ state: "delivered", source: "imported", year: 2062, number: 10 });
    await db
      .prepare(
        "INSERT INTO number_sequences (series_id, year, last_number) VALUES ('default', 2062, 10)",
      )
      .run();
    const progressive = await fileSequence();
    for (const requested of [10, 3, 1]) {
      const id = await insertInvoice({ requested });
      expect(await failure(reserve(id, "2062-04-01T10:00:00Z"))).toMatchObject({
        code: "number_unavailable",
        detail: expect.stringContaining("next free number is 11"),
      });
      const row = await db
        .prepare("SELECT state, number_int, year, requested_number_int FROM invoices WHERE id = ?")
        .bind(id)
        .first();
      expect(row).toEqual({
        state: "draft",
        number_int: null,
        year: null,
        requested_number_int: requested,
      });
    }
    expect(await sequenceOf(2062)).toBe(10);
    expect(await fileSequence()).toBe(progressive);
  });

  it("refuses a requested number below 1", async () => {
    const id = await insertInvoice({ requested: 0 });
    expect(await failure(reserve(id, "2063-04-01T10:00:00Z"))).toMatchObject({
      code: "number_unavailable",
    });
    expect(await sequenceOf(2063)).toBeNull();
  });

  it("lets exactly one of two devices win a requested number", async () => {
    const a = await insertInvoice({ requested: 7 });
    const b = await insertInvoice({ requested: 7 });
    const outcomes = await Promise.allSettled([
      reserve(a, "2064-04-01T10:00:00Z"),
      reserve(b, "2064-04-01T10:00:00Z"),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const lost = outcomes.find((o) => o.status === "rejected");
    expect(lost).toMatchObject({ reason: { code: "number_unavailable" } });
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM invoices WHERE year = 2064 AND number_int = 7")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("checks the requested number against the Europe/Rome year", async () => {
    await insertInvoice({ state: "sent", year: 2065, number: 9, issueDate: "2065-12-30" });
    // 22:30 UTC on 31 December is still 2065 in Rome: 5 is not above 9.
    const old = await insertInvoice({ requested: 5 });
    expect(await failure(reserve(old, "2065-12-31T22:30:00Z"))).toMatchObject({
      code: "number_unavailable",
    });
    // 23:30 UTC is already 1 January 2066 in Rome: a new year starts empty.
    const fresh = await reserve(old, "2065-12-31T23:30:00Z");
    expect([fresh.year, fresh.number]).toEqual([2066, 5]);
  });

  it("keeps the date rule for a requested number", async () => {
    await insertInvoice({ state: "sent", year: 2067, number: 5, issueDate: "2067-05-10" });
    const id = await insertInvoice({ requested: 50 });
    expect(await failure(reserve(id, "2067-05-09T10:00:00Z"))).toMatchObject({
      code: "conflict",
      detail: expect.stringContaining("date_before_last_issue"),
    });
    expect((await reserve(id, "2067-05-10T10:00:00Z")).number).toBe(50);
  });
});

describe("number release", () => {
  it("releases the highest reserved number and rolls the sequence back", async () => {
    const id = await insertInvoice();
    const first = await reserve(id, "2041-01-15T10:00:00Z");
    expect(first.number).toBe(1);
    const released = await releaseNumber(db, id);
    expect(released).toMatchObject({ state: "draft", number: 1, year: 2041 });
    expect(await sequenceOf(2041)).toBe(0);
    const row = await db
      .prepare("SELECT state, number_int, year, issue_date FROM invoices WHERE id = ?")
      .bind(id)
      .first();
    expect(row).toEqual({ state: "draft", number_int: null, year: null, issue_date: null });
    const left = await db
      .prepare("SELECT COUNT(*) AS n FROM transmissions WHERE invoice_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect((await reserve(id, "2041-01-16T10:00:00Z")).number).toBe(1);
  });

  it("returns a planned invoice to planned", async () => {
    const id = await insertInvoice({ state: "planned", invoiceDate: "2042-03-01" });
    await reserve(id, "2042-03-01T10:00:00Z");
    expect((await releaseNumber(db, id)).state).toBe("planned");
  });

  it("refuses to release a number that is not the highest of its year", async () => {
    const a = await insertInvoice();
    const b = await insertInvoice();
    await reserve(a, "2043-04-01T10:00:00Z");
    await reserve(b, "2043-04-01T10:05:00Z");
    expect(await failure(releaseNumber(db, a))).toMatchObject({
      code: "conflict",
      detail: "number_not_highest",
    });
    expect(await sequenceOf(2043)).toBe(2);
    const row = await db
      .prepare("SELECT state, number_int FROM invoices WHERE id = ?")
      .bind(a)
      .first();
    expect(row).toEqual({ state: "sending", number_int: 1 });
    // The highest one can go, and then the next one is the highest.
    await releaseNumber(db, b);
    await releaseNumber(db, a);
    expect(await sequenceOf(2043)).toBe(0);
  });

  it("refuses to release once a transmission reached the PEC", async () => {
    const id = await insertInvoice();
    await reserve(id, "2044-04-01T10:00:00Z");
    await db
      .prepare("UPDATE transmissions SET send_outcome = 'unknown' WHERE invoice_id = ?")
      .bind(id)
      .run();
    expect(await failure(releaseNumber(db, id))).toMatchObject({
      code: "conflict",
      detail: "number_not_releasable",
    });
    expect(await sequenceOf(2044)).toBe(1);
  });

  it("refuses to release an invoice without a number", async () => {
    const id = await insertInvoice();
    expect(await failure(releaseNumber(db, id))).toMatchObject({
      code: "conflict",
      detail: "not_numbered",
    });
  });
});

describe("transmission attempts", () => {
  const attempt = (invoiceId: string) =>
    addTransmissionAttempt(db, { invoiceId, now: new Date(), ...ISSUER });

  it("names the file in base 36 from the global counter, as the TypeScript encoder does", async () => {
    await db.prepare("UPDATE file_sequence SET last_value = 1295 WHERE id = 1").run();
    const reservation = await reserve(await insertInvoice(), "2046-01-10T10:00:00Z");
    expect(reservation.transmission.fileProgressive).toBe(1296);
    expect(reservation.transmission.fileName).toBe("IT12345678903_00100.xml");
    expect(encodeFileProgressive(1296)).toBe("00100");
  });

  it("gives a resend a new progressive and file name and keeps number and date", async () => {
    const id = await insertInvoice();
    const first = await reserve(id, "2047-02-03T10:00:00Z");
    await db
      .prepare("UPDATE invoices SET state = 'rejected', state_rank = 6 WHERE id = ?")
      .bind(id)
      .run();
    const second = await attempt(id);
    expect(second.attempt).toBe(2);
    expect(second.fileProgressive).toBeGreaterThan(first.transmission.fileProgressive);
    expect(second.fileName).not.toBe(first.transmission.fileName);
    expect(second.fileName).toBe(
      `IT12345678903_${encodeFileProgressive(second.fileProgressive)}.xml`,
    );
    const row = await db
      .prepare("SELECT number_int, issue_date FROM invoices WHERE id = ?")
      .bind(id)
      .first();
    expect(row).toEqual({ number_int: first.number, issue_date: first.issueDate });
  });

  it("allocates nothing for an unnumbered or locked invoice", async () => {
    const before = await db.prepare("SELECT last_value FROM file_sequence WHERE id = 1").first();
    expect(await failure(attempt(await insertInvoice()))).toMatchObject({ detail: "not_numbered" });
    const sent = await insertInvoice({
      state: "delivered",
      year: 2048,
      number: 1,
      issueDate: "2048-01-01",
    });
    expect(await failure(attempt(sent))).toMatchObject({ detail: "invoice_locked" });
    expect(await db.prepare("SELECT last_value FROM file_sequence WHERE id = 1").first()).toEqual(
      before,
    );
  });
});

describe("numbering series", () => {
  const addSeries = (id: string, prefix: string | null, suffix: string | null) =>
    db
      .prepare(
        `INSERT INTO numbering_series (id, name, prefix, suffix, is_default, created_at)
         VALUES (?, ?, ?, ?, 0, 0)`,
      )
      .bind(id, id, prefix, suffix)
      .run();

  it("keeps a progressive per series and prints prefix and suffix", async () => {
    await addSeries("ch", "CH-", null);
    await addSeries("eu", null, "/EU");
    const it1 = await reserve(await insertInvoice(), "2170-03-01T10:00:00Z");
    const ch1 = await reserve(await insertInvoice({ series: "ch" }), "2170-03-01T11:00:00Z");
    const ch2 = await reserve(await insertInvoice({ series: "ch" }), "2170-03-02T11:00:00Z");
    const eu1 = await reserve(await insertInvoice({ series: "eu" }), "2170-03-02T12:00:00Z");
    const it2 = await reserve(await insertInvoice(), "2170-03-03T10:00:00Z");
    expect([it1, ch1, ch2, eu1, it2].map((r) => r.numberText)).toEqual([
      "1",
      "CH-1",
      "CH-2",
      "1/EU",
      "2",
    ]);
    const row = await db
      .prepare("SELECT number_int, number_raw FROM invoices WHERE id = ?")
      .bind(ch2.invoiceId)
      .first();
    expect(row).toEqual({ number_int: 2, number_raw: "CH-2" });
    expect(await sequenceOf(2170, "ch")).toBe(2);
    expect(await sequenceOf(2170)).toBe(2);
  });

  it("proposes the next number of each series, counting imported invoices of that series", async () => {
    await addSeries("ch2", "CH-", "/2");
    await insertInvoice({
      state: "delivered",
      source: "imported",
      year: 2171,
      number: 7,
      issueDate: "2171-01-05",
      series: "ch2",
    });
    expect(await nextFreeNumber(db, 2171, "ch2")).toBe(8);
    expect(await nextFreeNumber(db, 2171, "default")).toBe(1);
  });

  it("applies the requested number rule and the date order per series", async () => {
    await addSeries("ch3", "CH", null);
    await insertInvoice({
      state: "delivered",
      year: 2172,
      number: 50,
      issueDate: "2172-06-01",
      series: "ch3",
    });
    // Another series ignores the number 50 and the June date.
    const other = await reserve(await insertInvoice({ requested: 3 }), "2172-02-01T10:00:00Z");
    expect(other.number).toBe(3);
    const low = await insertInvoice({ requested: 50, series: "ch3" });
    expect(await failure(reserve(low, "2172-07-01T10:00:00Z"))).toMatchObject({
      code: "number_unavailable",
    });
    const early = await insertInvoice({ series: "ch3" });
    expect(await failure(reserve(early, "2172-05-01T10:00:00Z"))).toMatchObject({
      code: "conflict",
    });
    const ok = await reserve(
      await insertInvoice({ requested: 60, series: "ch3" }),
      "2172-07-01T10:00:00Z",
    );
    expect(ok.numberText).toBe("CH60");
  });

  it("releases a number only when it is the highest of its own series", async () => {
    await addSeries("ch4", "X-", null);
    const a = await reserve(await insertInvoice({ series: "ch4" }), "2173-01-10T10:00:00Z");
    // A higher number in another series does not block the release.
    await reserve(await insertInvoice(), "2173-01-10T11:00:00Z");
    await reserve(await insertInvoice(), "2173-01-10T12:00:00Z");
    await releaseNumber(db, a.invoiceId);
    expect(await sequenceOf(2173, "ch4")).toBe(0);
    const again = await reserve(await insertInvoice({ series: "ch4" }), "2173-01-11T10:00:00Z");
    expect(again.numberText).toBe("X-1");
  });

  it("refuses a series that does not exist and keeps the printed number when the series changes", async () => {
    const orphan = await insertInvoice({ series: "gone" });
    expect(await failure(reserve(orphan, "2174-01-10T10:00:00Z"))).toMatchObject({
      code: "conflict",
      detail: "series_missing",
    });
    const kept = await reserve(await insertInvoice({ series: "ch" }), "2174-01-11T10:00:00Z");
    await db.prepare("UPDATE numbering_series SET prefix = 'ZZ-' WHERE id = 'ch'").run();
    const row = await db
      .prepare("SELECT number_raw FROM invoices WHERE id = ?")
      .bind(kept.invoiceId)
      .first();
    expect(row).toEqual({ number_raw: "CH-1" });
    const next = await reserve(await insertInvoice({ series: "ch" }), "2174-01-12T10:00:00Z");
    expect(next.numberText).toBe("ZZ-2");
  });
});
