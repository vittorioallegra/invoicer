import { describe, expect, it } from "vitest";
import { formatDate, formatMoney, resolveLocale } from "./format";

describe("formatting by UI locale", () => {
  it("formats cents as currency", () => {
    // CLDR: Italian omits the thousands separator for 4-digit integers.
    expect(formatMoney(104000, "it").replace(/\s/g, " ")).toBe("1.040,00 €");
    expect(formatMoney(12345600, "it").replace(/\s/g, " ")).toBe("123.456,00 €");
    expect(formatMoney(99999, "en")).toBe("€\u00a0999.99");
    expect(formatMoney(-35147, "en")).toBe("-€\u00a0351.47");
    expect(formatMoney(7000, "en", "USD")).toBe("US$\u00a070.00");
  });

  it("shows date-only strings without timezone shift", () => {
    expect(formatDate("2026-01-01", "en")).toContain("1");
    expect(formatDate("2026-12-31", "it")).toContain("31");
  });

  it("picks Italian only when preferred", () => {
    expect(resolveLocale(["it-IT", "en"])).toBe("it");
    expect(resolveLocale(["fr", "en"])).toBe("en");
  });
});
