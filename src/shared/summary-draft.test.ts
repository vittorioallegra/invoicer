import { describe, expect, it } from "vitest";
import type { SummaryAmounts } from "./import";
import { inferVatRateBp } from "./summary-draft";

const amounts = (over: Partial<SummaryAmounts>): SummaryAmounts => ({
  taxableCents: 10000,
  taxCents: 0,
  withholdingCents: 0,
  rivalsaCents: 0,
  cassaCents: 0,
  otherCassaCents: 0,
  ...over,
});

describe("inferVatRateBp", () => {
  it("finds 4, 5, 10 and 22 percent, counting cassa and rivalsa in the base", () => {
    expect(inferVatRateBp(amounts({ taxCents: 400 }))).toBe(400);
    expect(inferVatRateBp(amounts({ taxCents: 500 }))).toBe(500);
    expect(inferVatRateBp(amounts({ taxCents: 1000 }))).toBe(1000);
    expect(inferVatRateBp(amounts({ taxCents: 2200 }))).toBe(2200);
    expect(inferVatRateBp(amounts({ taxCents: 2288, cassaCents: 400 }))).toBe(2200);
    expect(inferVatRateBp(amounts({ taxCents: 2288, rivalsaCents: 400 }))).toBe(2200);
  });

  it("accepts a rounding difference of half a point and nothing further", () => {
    expect(inferVatRateBp(amounts({ taxCents: 2250 }))).toBe(2200);
    expect(inferVatRateBp(amounts({ taxCents: 2260 }))).toBeNull();
  });

  it("leaves the rate unset without IVA or without a base", () => {
    expect(inferVatRateBp(amounts({ taxCents: 0 }))).toBeNull();
    expect(inferVatRateBp(amounts({ taxableCents: 0, taxCents: 100 }))).toBeNull();
  });
});
