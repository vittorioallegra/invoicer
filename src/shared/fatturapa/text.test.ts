import { describe, expect, it } from "vitest";
import {
  convertToEurCents,
  formatBasisPoints,
  formatCents,
  formatQuantity,
  formatUnitPrice,
  parseExchangeRate,
} from "./numbers";
import { chunkText, naturaReference, toLatin } from "./text";

describe("number formatting", () => {
  it("formats cents, rates and quantities for the XSD patterns", () => {
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(123456)).toBe("1234.56");
    expect(formatCents(-250)).toBe("-2.50");
    expect(formatBasisPoints(2200)).toBe("22.00");
    expect(formatBasisPoints(525)).toBe("5.25");
    expect(formatQuantity(1000)).toBe("1.00");
    expect(formatQuantity(7500)).toBe("7.50");
    expect(formatQuantity(125)).toBe("0.125");
  });

  it("computes a unit price with up to 8 decimals", () => {
    expect(formatUnitPrice(96153, 1000)).toBe("961.53");
    expect(formatUnitPrice(10000, 3000)).toBe("33.33333333");
    expect(formatUnitPrice(1, 1000)).toBe("0.01");
  });

  it("parses exchange rates and converts half up", () => {
    expect(parseExchangeRate("1,0850")?.text).toBe("1.085");
    expect(parseExchangeRate("1")?.text).toBe("1.00");
    for (const bad of ["", "0", "-1", "1.2.3", "abc", "1.123456789"]) {
      expect(parseExchangeRate(bad), bad).toBeNull();
    }
    const rate = parseExchangeRate("1.0850");
    if (!rate) throw new Error("rate");
    expect(convertToEurCents(250000, rate)).toBe(230415);
    expect(convertToEurCents(0, rate)).toBe(0);
  });
});

describe("text helpers", () => {
  it("makes text Latin-1 safe", () => {
    expect(toLatin("a ’b’ — €5\r\nxł 中 café")).toBe("a 'b' - EUR5 xl ? café");
    expect(toLatin("abcdef", 3)).toBe("abc");
  });

  it("chunks at word boundaries", () => {
    expect(chunkText("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(chunkText("x".repeat(10), 4)).toEqual(["xxxx", "xxxx", "xx"]);
  });

  it("keeps a short natura text and shortens a long one to its citation", () => {
    expect(naturaReference("Operazione esente da IVA ai sensi dell'art. 10 del DPR 633/72")).toBe(
      "Operazione esente da IVA ai sensi dell'art. 10 del DPR 633/72",
    );
    const long =
      "Inversione contabile - operazioni del settore energetico ai sensi dell'art. 17, comma 6, lett. d-bis), d-ter) e d-quater) del DPR 633/72";
    const short = naturaReference(long);
    expect(short.length).toBeLessThanOrEqual(100);
    expect(short.startsWith("art. 17, comma 6")).toBe(true);
    const noCitation = naturaReference("word ".repeat(40));
    expect(noCitation.length).toBeLessThanOrEqual(100);
    expect(noCitation.endsWith("...")).toBe(true);
  });
});
