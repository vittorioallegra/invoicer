import { describe, expect, it } from "vitest";
import {
  formatInvoiceNumber,
  formatNumberWithYear,
  MAX_AFFIX_LENGTH,
  matchSeries,
  numberingSeriesInputSchema,
} from "./numbering";

describe("formatNumberWithYear", () => {
  it("appends the numbering year to the printed number", () => {
    expect(formatNumberWithYear("1", 2026)).toBe("1/2026");
    expect(formatNumberWithYear("CH-3", 2025)).toBe("CH-3/2025");
    expect(formatNumberWithYear("7-A", 2026)).toBe("7-A/2026");
  });

  it("is the bare number while there is no year", () => {
    expect(formatNumberWithYear("1", null)).toBe("1");
    expect(formatNumberWithYear("1", undefined)).toBe("1");
  });
});

describe("formatInvoiceNumber", () => {
  it("joins prefix, progressive and suffix", () => {
    expect(formatInvoiceNumber({ prefix: null, suffix: null }, 7)).toBe("7");
    expect(formatInvoiceNumber({ prefix: "CH-", suffix: null }, 3)).toBe("CH-3");
    expect(formatInvoiceNumber({ prefix: null, suffix: "/CH" }, 3)).toBe("3/CH");
    expect(formatInvoiceNumber({ prefix: "A.", suffix: "/B" }, 12)).toBe("A.12/B");
  });
});

describe("numberingSeriesInputSchema", () => {
  const parse = (value: unknown) => numberingSeriesInputSchema.safeParse(value);

  it("accepts a name alone and normalises empty affixes to null", () => {
    const parsed = parse({ name: " Italia ", prefix: "", suffix: "  " });
    expect(parsed.success && parsed.data).toEqual({ name: "Italia", prefix: null, suffix: null });
    expect(parse({ name: "Italia" }).success).toBe(true);
  });

  it("requires a name", () => {
    expect(parse({ name: "  " }).success).toBe(false);
  });

  it("accepts letters, digits and - / . only", () => {
    expect(parse({ name: "x", prefix: "CH-", suffix: "/2.a" }).success).toBe(true);
    for (const bad of ["CH_", "è", "A B", "CH#"]) {
      const parsed = parse({ name: "x", prefix: bad });
      expect(parsed.success).toBe(false);
      expect(!parsed.success && parsed.error.issues[0]?.message).toBe("invalid_affix");
    }
  });

  it("keeps the full number within 20 characters (9 for the progressive)", () => {
    expect(MAX_AFFIX_LENGTH).toBe(11);
    expect(parse({ name: "x", prefix: "ABCDEF", suffix: "GHIJK" }).success).toBe(true);
    const long = parse({ name: "x", prefix: "ABCDEF", suffix: "GHIJKL" });
    expect(long.success).toBe(false);
    expect(!long.success && long.error.issues[0]?.message).toBe("affix_too_long");
    expect(parse({ name: "x", prefix: "ABCDEFGHIJKL" }).success).toBe(false);
  });
});

describe("matchSeries", () => {
  const series = [
    { id: "it", prefix: null, suffix: null, isDefault: true },
    { id: "ch", prefix: "CH-", suffix: null, isDefault: false },
    { id: "eu", prefix: null, suffix: "/EU", isDefault: false },
  ];

  it("assigns a number that clearly matches a prefix or suffix to that series", () => {
    expect(matchSeries("CH-12", series)).toEqual({ seriesId: "ch", progressive: 12 });
    expect(matchSeries("5/EU", series)).toEqual({ seriesId: "eu", progressive: 5 });
  });

  it("uses the default series for plain and unrecognised numbers", () => {
    expect(matchSeries("42", series)).toEqual({ seriesId: "it", progressive: 42 });
    expect(matchSeries("CH-x", series)).toEqual({ seriesId: "it", progressive: null });
    expect(matchSeries("2024/7", series)).toEqual({ seriesId: "it", progressive: null });
  });
});
