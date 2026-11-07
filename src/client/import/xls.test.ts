import { describe, expect, it } from "vitest";
import { readXls, serialToIsoDate, XlsError } from "./xls";
import { buildXls } from "./xls-fixture";

const sheet = {
  name: "Contabilità",
  rows: [
    ["Title ✓", null, "Acme S.r.l."],
    [1, { rk: 2 }, { mulrk: [3, 4.25, -7] }, null, null, 1234.56, "x"],
    [{ label: "inline" }, { rich: "Rich text", runs: 2 }, "Acme S.r.l."],
  ],
};

describe("readXls", () => {
  it("reads text, numbers, RK and MULRK cells from a workbook in regular sectors", () => {
    const book = readXls(buildXls([sheet]));
    expect(book.date1904).toBe(false);
    expect(book.sheets.map((s) => s.name)).toEqual(["Contabilità"]);
    const rows = book.sheets[0]?.rows ?? [];
    expect(rows[0]).toEqual(["Title ✓", undefined, "Acme S.r.l."]);
    expect(rows[1]).toEqual([1, 2, 3, 4.25, -7, 1234.56, "x"]);
    expect(rows[2]).toEqual(["inline", "Rich text", "Acme S.r.l."]);
  });

  it("joins a string table that spills into CONTINUE records, even in the middle of a string", () => {
    const long = "abcdefghijklmnopqrstuvwxyz0123456789";
    const wide = "Ünïcode ✓ naïve façade — wide characters";
    const rows = [[long, wide, long.toUpperCase(), "short"]];
    const book = readXls(buildXls([{ name: "S", rows }], { chunkLimit: 30 }));
    expect(book.sheets[0]?.rows[0]).toEqual([long, wide, long.toUpperCase(), "short"]);
  });

  it("reads a small workbook from the mini stream and several sheets", () => {
    const book = readXls(
      buildXls(
        [
          { name: "One", rows: [["a", 1]] },
          { name: "Two", rows: [[], ["b", 2]] },
        ],
        { mini: true },
      ),
    );
    expect(book.sheets.map((s) => s.name)).toEqual(["One", "Two"]);
    expect(book.sheets[1]?.rows[1]).toEqual(["b", 2]);
  });

  it("reports the 1904 date system", () => {
    expect(readXls(buildXls([sheet], { date1904: true })).date1904).toBe(true);
  });

  it("throws a typed error for anything that is not a workbook", () => {
    const good = buildXls([sheet]);
    const failures = [
      new Uint8Array(0),
      new TextEncoder().encode("a,b,c\n1,2,3\n".repeat(100)),
      good.subarray(0, 1000),
      good.subarray(0, good.length - 700),
    ];
    for (const bytes of failures) expect(() => readXls(bytes)).toThrow(XlsError);
    expect(() => readXls(new Uint8Array(11 * 1024 * 1024))).toThrow(XlsError);
  });
});

describe("serialToIsoDate", () => {
  it("converts serial numbers in both date systems", () => {
    expect(serialToIsoDate(45000)).toBe("2023-03-15");
    expect(serialToIsoDate(45000.75)).toBe("2023-03-15");
    expect(serialToIsoDate(45000 - 1462, true)).toBe("2023-03-15");
    expect(serialToIsoDate(0)).toBeNull();
    expect(serialToIsoDate(Number.NaN)).toBeNull();
  });
});
