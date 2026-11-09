import { describe, expect, it } from "vitest";
import type { ReceivedInvoiceRecord } from "./received";
import {
  filterReceived,
  receivedRecap,
  receivedSuppliers,
  receivedYears,
  supplierKey,
} from "./received-filters";

const rec = (over: Partial<ReceivedInvoiceRecord>): ReceivedInvoiceRecord => ({
  id: "r",
  parseStatus: "parsed",
  supplierName: "Alpha Srl",
  supplierVat: "IT01234567890",
  number: "1",
  issueDate: "2026-03-10",
  documentType: "TD01",
  currency: "EUR",
  totalCents: 10000,
  paymentFlag: "unpaid",
  paidDate: null,
  source: "import",
  receivedAt: 1,
  original: null,
  ...over,
});

const list = [
  rec({ id: "a1", issueDate: "2026-03-10", totalCents: 12200 }),
  rec({ id: "a2", issueDate: "2025-11-02", totalCents: 5000, paymentFlag: "paid" }),
  rec({
    id: "b1",
    supplierName: "beta GmbH",
    supplierVat: null,
    issueDate: "2026-01-05",
    totalCents: 800,
    currency: "CHF",
  }),
  rec({
    id: "c1",
    supplierName: "Alpha Srl",
    supplierVat: "it01234567890",
    issueDate: "2026-06-01",
    documentType: "TD04",
    totalCents: 2000,
  }),
  rec({
    id: "p1",
    parseStatus: "pending",
    supplierName: null,
    supplierVat: null,
    issueDate: null,
    totalCents: null,
  }),
];

describe("received filters", () => {
  it("keeps every year by default, or one year (and what has no date yet)", () => {
    expect(filterReceived(list, {})).toHaveLength(5);
    expect(filterReceived(list, { year: "all" })).toHaveLength(5);
    expect(filterReceived(list, { year: "2026" }).map((r) => r.id)).toEqual([
      "a1",
      "b1",
      "c1",
      "p1",
    ]);
    expect(filterReceived(list, { year: "2025" }).map((r) => r.id)).toEqual(["a2", "p1"]);
  });

  it("filters by sender, whichever way the VAT number is written, and leaves unread ones out", () => {
    expect(supplierKey(list[0] as ReceivedInvoiceRecord)).toBe(
      supplierKey(list[3] as ReceivedInvoiceRecord),
    );
    const alpha = supplierKey(list[0] as ReceivedInvoiceRecord) as string;
    expect(filterReceived(list, { year: "all", supplier: alpha }).map((r) => r.id)).toEqual([
      "a1",
      "a2",
      "c1",
    ]);
    const beta = supplierKey(list[2] as ReceivedInvoiceRecord) as string;
    expect(beta).toBe("beta gmbh");
    expect(filterReceived(list, { year: "all", supplier: beta }).map((r) => r.id)).toEqual(["b1"]);
  });

  it("lists the years, newest first and always the current one, and the senders by name", () => {
    expect(receivedYears(list, "2027")).toEqual([2027, 2026, 2025]);
    expect(receivedSuppliers(list).map((s) => s.name)).toEqual(["Alpha Srl", "beta GmbH"]);
  });
});

describe("received recap", () => {
  it("sums per currency with credit notes subtracted, and counts what is listed to pay", () => {
    const recap = receivedRecap(list);
    expect(recap.count).toBe(5);
    expect(recap.byCurrency).toEqual([
      // 122,00 + 50,00 (paid) - 20,00 credit note; to pay: 122,00 - 20,00
      { currency: "EUR", receivedCents: 12200 + 5000 - 2000, toPayCents: 12200 - 2000 },
      { currency: "CHF", receivedCents: 800, toPayCents: 800 },
    ]);
  });

  it("is zero in euro for an empty set", () => {
    expect(receivedRecap([])).toEqual({
      count: 0,
      byCurrency: [{ currency: "EUR", receivedCents: 0, toPayCents: 0 }],
    });
  });
});
