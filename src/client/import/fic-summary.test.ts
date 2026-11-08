import { describe, expect, it } from "vitest";
import { missingSeries, parseFicSummary, yearRange } from "./fic-summary";
import { readXls } from "./xls";
import { buildXls, type FixtureCell } from "./xls-fixture";

// Excel serial numbers of invented dates (1900 date system).
const serial = (iso: string) =>
  Math.round(
    (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) /
      86_400_000,
  );

const ISSUED_HEADER = [
  "# Fattura emessa",
  "Data",
  "Cliente",
  "P.IVA",
  "CF",
  "Imponibile",
  "IVA",
  "Rit. d'acconto",
  "Rit. previdenziale",
  "Rivalsa INPS",
  "Cassa previdenziale",
  "Altra cassa prev.",
];
const RECEIVED_HEADER = [
  "# Fattura ricevuta",
  "Data",
  "Fornitore",
  "P.IVA",
  "CF",
  "Imponibile",
  "Deducibilità",
  "IVA",
  "Detraibilità",
  "Rit. d'acconto",
  "Rit. previdenziale",
  "Anni ammortamento",
];

const rows: FixtureCell[][] = [
  ["Contabilità generata da FattureInCloud.it per"],
  ["Mario Rossi"],
  ["Periodo 01/01/2024 - 31/12/2025"],
  [],
  ["Gennaio"],
  ["Fatture emesse"],
  ISSUED_HEADER,
  [
    1,
    serial("2024-01-15"),
    "Acme S.r.l.",
    "12345678903 ",
    "RSSMRA80A01H501U ",
    1000,
    220,
    200,
    0,
    40,
    10,
    5,
  ],
  ["3/CH", serial("2025-01-20"), "Beta GmbH", " ", " ", 500.5, 0, 0, 0, 0, 0, 0],
  ["Totale", null, null, null, null, 1500.5],
  ["Fatture ricevute"],
  RECEIVED_HEADER,
  [7, serial("2024-01-05"), "Tool Shop", "98765432109 ", " ", 100, 100, 22, 100, 0, 0, 0],
  ["Totale", null, null, null, null, 100],
  ["* footnote about deductibility"],
  ["Febbraio"],
  ["Fatture emesse"],
  ISSUED_HEADER,
  [2, 0, "No date", " ", " ", 10, 0],
  [null, serial("2024-02-10"), "No number", " ", " ", 10, 0],
  [4, serial("2024-02-11"), " ", " ", " ", 10, 0],
  [5, serial("2024-02-12"), "Credit note client", " ", " ", -100, -22],
  ["Totale"],
  ["Fatture ricevute"],
  RECEIVED_HEADER,
  ["Marzo"],
  ["Riepilogo anno fiscale 2024"],
  ["Mese", "Imponibile", "Costi", "Utile", "IVA a debito", "IVA a credito"],
  [1, 9999, 9999],
];

const parse = (sheet = rows, options = {}) =>
  parseFicSummary(readXls(buildXls([{ name: "Contabilità", rows: sheet }], options)));

describe("parseFicSummary", () => {
  const summary = parse();

  it("reads the issued rows with derived totals, padded ids and text numbers", () => {
    expect(summary?.issued.map((item) => item.row)).toEqual([
      {
        documentType: "TD01",
        number: "1",
        date: "2024-01-15",
        currency: "EUR",
        // taxable + VAT + rivalsa + cassa + altra cassa; the withholding tax is not added.
        totalCents: 100000 + 22000 + 4000 + 1000 + 500,
        customer: {
          name: "Acme S.r.l.",
          vatCountry: "IT",
          vatCode: "12345678903",
          taxCode: "RSSMRA80A01H501U",
        },
        amounts: {
          taxableCents: 100000,
          taxCents: 22000,
          withholdingCents: 20000,
          rivalsaCents: 4000,
          cassaCents: 1000,
          otherCassaCents: 500,
        },
      },
      {
        documentType: "TD01",
        number: "3/CH",
        date: "2025-01-20",
        currency: "EUR",
        totalCents: 50050,
        customer: { name: "Beta GmbH", vatCountry: null, vatCode: null, taxCode: null },
        amounts: {
          taxableCents: 50050,
          taxCents: 0,
          withholdingCents: 0,
          rivalsaCents: 0,
          cassaCents: 0,
          otherCassaCents: 0,
        },
      },
      {
        documentType: "TD04",
        number: "5",
        date: "2024-02-12",
        currency: "EUR",
        totalCents: 12200,
        customer: { name: "Credit note client", vatCountry: null, vatCode: null, taxCode: null },
        amounts: {
          taxableCents: 10000,
          taxCents: 2200,
          withholdingCents: 0,
          rivalsaCents: 0,
          cassaCents: 0,
          otherCassaCents: 0,
        },
      },
    ]);
    expect(summary?.issued[0]?.line).toBe(8);
  });

  it("reads the received rows and ignores totals, footnotes and the yearly recap", () => {
    expect(summary?.received.map((item) => item.row)).toEqual([
      {
        supplierName: "Tool Shop",
        supplierVat: "98765432109",
        number: "7",
        issueDate: "2024-01-05",
        documentType: "TD01",
        currency: "EUR",
        totalCents: 12200,
      },
    ]);
    expect(yearRange(summary ?? { issued: [], received: [], invalid: [] })).toEqual({
      from: 2024,
      to: 2025,
    });
  });

  it("reports the rows it cannot read with their sheet row", () => {
    expect(summary?.invalid).toEqual([
      { line: 19, kind: "issued", field: "date" },
      { line: 20, kind: "issued", field: "number" },
      { line: 21, kind: "issued", field: "name" },
    ]);
  });

  it("finds columns by header text, whatever their position", () => {
    const shuffled = parse([
      ["Extra"],
      ["Fattura emessa #", "Cliente", "Note", "Data", "IVA", "Imponibile"],
      [9, "Gamma", "n", serial("2025-06-30"), 22, 100],
    ]);
    expect(shuffled?.issued[0]?.row).toMatchObject({
      number: "9",
      date: "2025-06-30",
      totalCents: 12200,
      customer: { name: "Gamma" },
    });
  });

  it("is null for a workbook without the section headers", () => {
    expect(
      parse([
        ["a", "b"],
        [1, 2],
      ]),
    ).toBeNull();
  });
});

describe("missingSeries", () => {
  const existing = [
    { id: "default", name: "Default", prefix: null, suffix: null, isDefault: true },
    { id: "s1", name: "FA", prefix: "FA-", suffix: null, isDefault: false },
  ];

  it("lists the series the numbers need, once, and leaves existing ones alone", () => {
    const series = missingSeries(
      ["1", "2", "3/CH", "9/CH", "A-12", "FA-3", "7 bis", "5/CH/X"],
      existing,
    );
    expect(series).toEqual([
      { name: "CH", prefix: null, suffix: "/CH" },
      { name: "A", prefix: "A-", suffix: null },
      { name: "CH X", prefix: null, suffix: "/CH/X" },
    ]);
  });

  it("does not reuse the name of an existing series", () => {
    const named = [
      ...existing,
      { id: "s2", name: "CH", prefix: "X", suffix: null, isDefault: false },
    ];
    expect(missingSeries(["3/CH"], named)).toEqual([{ name: "CH 2", prefix: null, suffix: "/CH" }]);
  });
});
