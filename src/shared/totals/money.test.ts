import { describe, expect, it } from "vitest";
import { divRound, parseMoney } from "./money";

describe("parseMoney", () => {
  it.each([
    ["1040,00", 104000],
    ["1.040,00", 104000],
    ["1,040.00", 104000],
    ["1040", 104000],
    ["1040.5", 104050],
    ["1040,5", 104050],
    ["0,99", 99],
    ["999.99", 99999],
    ["1.234.567,89", 123456789],
    ["1,234,567.89", 123456789],
    ["1.040", 104000],
    ["1,040", 104000],
    [" 12,30 € ", 1230],
    ["-12,50", -1250],
  ])("parses %s", (input, cents) => {
    expect(parseMoney(input)).toBe(cents);
  });

  it.each([
    "",
    "abc",
    "-",
    "1,2,3",
    "1.04.0,00",
    "12,345,67",
    "1.040,000",
    "0,125",
    "1,040,00",
    ".",
  ])("rejects %j", (input) => {
    expect(parseMoney(input)).toBeNull();
  });
});

describe("divRound", () => {
  it("rounds half up, away from zero", () => {
    expect(divRound(5, 10)).toBe(1);
    expect(divRound(4, 10)).toBe(0);
    expect(divRound(-5, 10)).toBe(-1);
    expect(divRound(-4, 10)).toBe(0);
    expect(divRound(25, 10)).toBe(3);
  });
});
