import { describe, expect, it } from "vitest";
import {
  dueDate,
  endOfMonth,
  legacyTerms,
  nearestTermsDays,
  type PaymentTerms,
  termsReferenceDate,
} from "./payment-terms";

const df = (days: PaymentTerms["days"]): PaymentTerms => ({ days, basis: "invoice_date" });
const fm = (days: PaymentTerms["days"]): PaymentTerms => ({ days, basis: "end_of_month" });

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

describe("legacy default", () => {
  it("maps a free-form number of days to the nearest allowed value from the invoice date", () => {
    expect(nearestTermsDays(0)).toBe(0);
    expect(nearestTermsDays(14)).toBe(0);
    expect(nearestTermsDays(15)).toBe(0);
    expect(nearestTermsDays(16)).toBe(30);
    expect(nearestTermsDays(45)).toBe(30);
    expect(nearestTermsDays(75)).toBe(60);
    expect(nearestTermsDays(365)).toBe(120);
    expect(legacyTerms(30)).toEqual({ days: 30, basis: "invoice_date" });
  });
});
