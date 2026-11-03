import { describe, expect, it } from "vitest";
import { dueDate, legacyTerms, type PaymentTerms, paymentTermsSchema } from "./payment-terms";

const invoiceDate: PaymentTerms = { kind: "invoice_date" };
const eom15: PaymentTerms = { kind: "eom_15" };
const eom30: PaymentTerms = { kind: "eom_30" };
const eom60: PaymentTerms = { kind: "eom_60" };
const custom = (days: number): PaymentTerms => ({ kind: "custom", days });

describe("dueDate", () => {
  it("invoice date: due on the issue date", () => {
    expect(dueDate("2026-11-10", invoiceDate)).toBe("2026-11-10");
    expect(dueDate("2026-12-31", invoiceDate)).toBe("2026-12-31");
  });

  it("15 days end of month: end of the invoice month plus 15 days", () => {
    expect(dueDate("2026-11-10", eom15)).toBe("2026-12-15");
    expect(dueDate("2026-01-31", eom15)).toBe("2026-02-15");
    expect(dueDate("2026-12-31", eom15)).toBe("2027-01-15");
    expect(dueDate("2028-02-10", eom15)).toBe("2028-03-15");
  });

  it("30 days end of month: last day of the month after the invoice month", () => {
    expect(dueDate("2026-11-10", eom30)).toBe("2026-12-31");
    expect(dueDate("2026-01-31", eom30)).toBe("2026-02-28");
    expect(dueDate("2028-01-15", eom30)).toBe("2028-02-29");
    expect(dueDate("2026-12-20", eom30)).toBe("2027-01-31");
    expect(dueDate("2026-07-01", eom30)).toBe("2026-08-31");
  });

  it("60 days end of month: last day of the second month after the invoice month", () => {
    expect(dueDate("2026-11-10", eom60)).toBe("2027-01-31");
    expect(dueDate("2026-12-31", eom60)).toBe("2027-02-28");
    expect(dueDate("2027-12-31", eom60)).toBe("2028-02-29");
    expect(dueDate("2026-01-05", eom60)).toBe("2026-03-31");
  });

  it("custom: days added to the invoice date", () => {
    expect(dueDate("2026-11-10", custom(30))).toBe("2026-12-10");
    expect(dueDate("2026-11-10", custom(0))).toBe("2026-11-10");
    expect(dueDate("2026-11-10", custom(60))).toBe("2027-01-09");
    expect(dueDate("2027-01-29", custom(30))).toBe("2027-02-28");
    expect(dueDate("2026-12-31", custom(120))).toBe("2027-04-30");
  });
});

describe("terms schema", () => {
  const ok = (value: unknown) => paymentTermsSchema.safeParse(value).success;

  it("accepts the five kinds and custom days 0-365", () => {
    expect(paymentTermsSchema.parse({ kind: "eom_30" })).toEqual(eom30);
    expect(ok({ kind: "custom", days: 0 })).toBe(true);
    expect(ok({ kind: "custom", days: 365 })).toBe(true);
    expect(ok({ kind: "custom", days: 366 })).toBe(false);
    expect(ok({ kind: "custom", days: -1 })).toBe(false);
    expect(ok({ kind: "custom", days: 1.5 })).toBe(false);
    expect(ok({ kind: "custom" })).toBe(false);
    expect(ok({ kind: "weekly" })).toBe(false);
    expect(ok(null)).toBe(false);
  });
});

describe("legacy shapes", () => {
  const read = (value: unknown) => paymentTermsSchema.parse(value);

  it("invoice-date terms: 0 days is the invoice date, otherwise custom days", () => {
    expect(read({ days: 0, basis: "invoice_date", extraDays: 0 })).toEqual(invoiceDate);
    expect(read({ days: 0, basis: "invoice_date" })).toEqual(invoiceDate);
    expect(read({ days: 30, basis: "invoice_date", extraDays: 0 })).toEqual(custom(30));
    expect(read({ days: 90, basis: "invoice_date" })).toEqual(custom(90));
  });

  it("end-of-month terms map to the matching kind, else custom days plus extra days", () => {
    expect(read({ days: 0, basis: "end_of_month", extraDays: 15 })).toEqual(eom15);
    expect(read({ days: 30, basis: "end_of_month", extraDays: 0 })).toEqual(eom30);
    expect(read({ days: 30, basis: "end_of_month" })).toEqual(eom30);
    expect(read({ days: 60, basis: "end_of_month", extraDays: 0 })).toEqual(eom60);
    expect(read({ days: 90, basis: "end_of_month", extraDays: 0 })).toEqual(custom(90));
    expect(read({ days: 0, basis: "end_of_month", extraDays: 5 })).toEqual(custom(5));
    expect(read({ days: 30, basis: "end_of_month", extraDays: 10 })).toEqual(custom(40));
  });

  it("a plain number of days follows the invoice-date rule", () => {
    expect(read(0)).toEqual(invoiceDate);
    expect(read(45)).toEqual(custom(45));
    expect(legacyTerms(30)).toEqual(custom(30));
    expect(legacyTerms(0)).toEqual(invoiceDate);
    expect(legacyTerms(400)).toEqual(custom(365));
  });

  it("still rejects invalid legacy values", () => {
    expect(paymentTermsSchema.safeParse({ days: 366, basis: "invoice_date" }).success).toBe(false);
    expect(paymentTermsSchema.safeParse({ days: 30, basis: "month" }).success).toBe(false);
    expect(
      paymentTermsSchema.safeParse({ days: 0, basis: "end_of_month", extraDays: 32 }).success,
    ).toBe(false);
  });
});
