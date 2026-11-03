import { describe, expect, it } from "vitest";
import {
  dueDate,
  endOfMonth,
  legacyTerms,
  type PaymentTerms,
  paymentTermsSchema,
  termsReferenceDate,
} from "./payment-terms";

const df = (days: number): PaymentTerms => ({ days, basis: "invoice_date", extraDays: 0 });
const fm = (days: number, extraDays = 0): PaymentTerms => ({
  days,
  basis: "end_of_month",
  extraDays,
});

describe("dueDate", () => {
  it("0 days from the invoice date is the invoice date", () => {
    expect(dueDate("2026-11-10", df(0))).toBe("2026-11-10");
  });

  it("counts days from the invoice date", () => {
    expect(dueDate("2026-11-10", df(30))).toBe("2026-12-10");
    expect(dueDate("2026-11-10", df(60))).toBe("2027-01-09");
    expect(dueDate("2026-11-10", df(90))).toBe("2027-02-08");
    expect(dueDate("2026-11-10", df(120))).toBe("2027-03-10");
  });

  it("moves the date to the end of the month for 'fine mese data fattura'", () => {
    expect(dueDate("2026-11-10", fm(30))).toBe("2026-12-31");
    expect(dueDate("2026-11-10", fm(0))).toBe("2026-11-30");
    expect(dueDate("2026-11-30", fm(0))).toBe("2026-11-30");
    expect(dueDate("2026-11-10", fm(60))).toBe("2027-01-31");
    expect(dueDate("2026-11-10", fm(90))).toBe("2027-02-28");
    expect(dueDate("2026-11-10", fm(120))).toBe("2027-03-31");
  });

  it("handles February, leap years and 31-day months", () => {
    expect(dueDate("2027-01-31", fm(30))).toBe("2027-03-31");
    expect(dueDate("2027-01-29", df(30))).toBe("2027-02-28");
    expect(dueDate("2027-01-29", fm(30))).toBe("2027-02-28");
    expect(dueDate("2028-01-30", fm(30))).toBe("2028-02-29");
    expect(dueDate("2028-02-10", fm(0))).toBe("2028-02-29");
    expect(dueDate("2026-08-31", df(30))).toBe("2026-09-30");
    expect(dueDate("2026-07-31", fm(30))).toBe("2026-08-31");
  });

  it("crosses the year change", () => {
    expect(dueDate("2026-12-20", df(30))).toBe("2027-01-19");
    expect(dueDate("2026-12-20", fm(30))).toBe("2027-01-31");
    expect(dueDate("2026-12-31", df(0))).toBe("2026-12-31");
    expect(dueDate("2026-12-31", df(120))).toBe("2027-04-30");
  });
});

describe("termsReferenceDate", () => {
  it("is the invoice date or the end of its month", () => {
    expect(termsReferenceDate("2026-11-10", df(30))).toBe("2026-11-10");
    expect(termsReferenceDate("2026-11-10", fm(30))).toBe("2026-11-30");
    expect(endOfMonth("2028-02-01")).toBe("2028-02-29");
  });
});

describe("extra days after the end of month", () => {
  it("adds them after the end of the month", () => {
    expect(dueDate("2026-11-10", fm(0, 5))).toBe("2026-12-05");
    expect(dueDate("2026-11-10", fm(30, 0))).toBe("2026-12-31");
    expect(dueDate("2026-11-10", fm(30, 10))).toBe("2027-01-10");
    expect(dueDate("2026-11-10", df(30))).toBe("2026-12-10");
    expect(dueDate("2026-11-10", df(0))).toBe("2026-11-10");
  });

  it("handles February and leap years", () => {
    expect(dueDate("2027-01-10", fm(0, 5))).toBe("2027-02-05");
    expect(dueDate("2027-01-31", fm(30, 3))).toBe("2027-04-03");
    expect(dueDate("2028-02-10", fm(0, 1))).toBe("2028-03-01");
    expect(dueDate("2027-02-10", fm(0, 1))).toBe("2027-03-01");
    expect(dueDate("2028-01-30", fm(30, 31))).toBe("2028-03-31");
  });
});

describe("terms schema", () => {
  it("defaults extraDays to 0 and drops it for invoice-date terms", () => {
    expect(paymentTermsSchema.parse({ days: 30, basis: "end_of_month" })).toEqual({
      days: 30,
      basis: "end_of_month",
      extraDays: 0,
    });
    expect(paymentTermsSchema.parse({ days: 30, basis: "invoice_date", extraDays: 9 })).toEqual(
      df(30),
    );
  });

  it("accepts any whole number of days 0-365 and 0-31 extra days", () => {
    const ok = (value: unknown) => paymentTermsSchema.safeParse(value).success;
    expect(ok({ days: 45, basis: "invoice_date" })).toBe(true);
    expect(ok({ days: 365, basis: "end_of_month", extraDays: 31 })).toBe(true);
    expect(ok({ days: 366, basis: "invoice_date" })).toBe(false);
    expect(ok({ days: -1, basis: "invoice_date" })).toBe(false);
    expect(ok({ days: 1.5, basis: "invoice_date" })).toBe(false);
    expect(ok({ days: 0, basis: "end_of_month", extraDays: 32 })).toBe(false);
  });
});

describe("legacy default", () => {
  it("keeps the number of days as is, clamped to 0-365, from the invoice date", () => {
    expect(legacyTerms(30)).toEqual(df(30));
    expect(legacyTerms(45)).toEqual(df(45));
    expect(legacyTerms(0)).toEqual(df(0));
    expect(legacyTerms(400)).toEqual(df(365));
  });
});
