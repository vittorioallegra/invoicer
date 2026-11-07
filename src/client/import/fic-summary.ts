import type { IssuedSummaryRow, ReceivedSummaryRow } from "../../shared/import";
import {
  matchSeries,
  type NumberingSeriesData,
  type NumberingSeriesRecord,
  numberingSeriesInputSchema,
} from "../../shared/numbering";
import { serialToIsoDate, type XlsCell, type XlsWorkbook } from "./xls";

/**
 * Reads the "account summary" spreadsheet that Fatture in Cloud exports (one sheet, per month an
 * issued and a received block; see docs/plans/invoicer.md). Columns are found by their header
 * text, so a file with a few columns more or less still reads. The yearly recap at the end is
 * ignored. A row carries no lines, due date or original file; the totals are derived here.
 */

/** A row without the paid flag, which the owner picks on the preview. */
export type SummaryIssued = Omit<IssuedSummaryRow, "paid">;
export type SummaryReceived = Omit<ReceivedSummaryRow, "paid">;

export interface FicIssuedRow {
  /** One-based row of the sheet, for messages. */
  line: number;
  row: SummaryIssued;
}
export interface FicReceivedRow {
  line: number;
  row: SummaryReceived;
}
export interface FicInvalidRow {
  line: number;
  kind: "issued" | "received";
  /** The field that could not be read (`number`, `date`, `name` or `amount`). */
  field: "number" | "date" | "name" | "amount";
}

export interface FicSummary {
  issued: FicIssuedRow[];
  received: FicReceivedRow[];
  invalid: FicInvalidRow[];
}

type Column =
  | "number"
  | "date"
  | "name"
  | "vat"
  | "taxCode"
  | "taxable"
  | "tax"
  | "rivalsa"
  | "cassa"
  | "otherCassa";

const HEADERS: Record<"issued" | "received", Record<string, Column>> = {
  issued: {
    fatturaemessa: "number",
    data: "date",
    cliente: "name",
    piva: "vat",
    cf: "taxCode",
    imponibile: "taxable",
    iva: "tax",
    rivalsainps: "rivalsa",
    cassaprevidenziale: "cassa",
    altracassaprev: "otherCassa",
  },
  received: {
    fatturaricevuta: "number",
    data: "date",
    fornitore: "name",
    piva: "vat",
    cf: "taxCode",
    imponibile: "taxable",
    iva: "tax",
  },
};

/** Header text compared without case, accents, spaces and punctuation. */
const normalize = (cell: XlsCell | undefined): string =>
  String(cell ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const textOf = (cell: XlsCell | undefined): string =>
  typeof cell === "number" ? String(cell) : (cell ?? "").trim();

type ColumnMap = Partial<Record<Column, number>>;

/** The column map of a header row, or null when it is not the header of that block. */
function headerOf(cells: (XlsCell | undefined)[], kind: "issued" | "received"): ColumnMap | null {
  const wanted = HEADERS[kind];
  const map: ColumnMap = {};
  cells.forEach((cell, index) => {
    const column = wanted[normalize(cell)];
    if (column !== undefined && map[column] === undefined) map[column] = index;
  });
  const required: Column[] = ["number", "date", "name", "taxable"];
  return required.every((column) => map[column] !== undefined) ? map : null;
}

/** Cents of an amount cell (euro as a float): empty is zero, text that is not a number is null. */
function centsOf(cell: XlsCell | undefined): number | null {
  if (cell === undefined || (typeof cell === "string" && cell.trim() === "")) return 0;
  const value = typeof cell === "number" ? cell : Number(cell.trim().replace(",", "."));
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** An invoice number: whole numbers without a decimal point, text as written. */
function numberOf(cell: XlsCell | undefined): string | null {
  const value =
    typeof cell === "number" ? (Number.isInteger(cell) ? String(cell) : "") : textOf(cell);
  return value === "" ? null : value;
}

function dateOf(cell: XlsCell | undefined, date1904: boolean): string | null {
  if (typeof cell === "number") return serialToIsoDate(cell, date1904);
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(textOf(cell));
  if (!match) return null;
  const [, day = "", month = "", year = ""] = match;
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** The text of a cell that held padding (a single space for "empty"): null when blank. */
const optional = (cell: XlsCell | undefined): string | null => textOf(cell) || null;

/**
 * Reads the summary from the workbook; null when no sheet has the expected section headers
 * (the file is not an account summary).
 */
export function parseFicSummary(book: XlsWorkbook): FicSummary | null {
  for (const sheet of book.sheets) {
    const summary: FicSummary = { issued: [], received: [], invalid: [] };
    let found = false;
    let kind: "issued" | "received" | null = null;
    let map: ColumnMap = {};
    for (let index = 0; index < sheet.rows.length; index++) {
      const cells = sheet.rows[index];
      if (!cells) continue;
      const first = textOf(cells.find((cell) => textOf(cell) !== ""));
      // The yearly recap at the end is not invoices.
      if (normalize(first).startsWith("riepilogoanno")) break;
      const issuedHeader = headerOf(cells, "issued");
      const receivedHeader = issuedHeader ? null : headerOf(cells, "received");
      if (issuedHeader || receivedHeader) {
        kind = issuedHeader ? "issued" : "received";
        map = issuedHeader ?? receivedHeader ?? {};
        found = true;
        continue;
      }
      if (kind === null || first === "") continue;
      if (normalize(first).startsWith("totale")) {
        kind = null;
        continue;
      }
      const at = (column: Column) => (map[column] === undefined ? undefined : cells[map[column]]);
      const line = index + 1;
      // A month or section title (no date, name or amount) is not an invoice row.
      if (textOf(at("date")) === "" && textOf(at("name")) === "" && textOf(at("taxable")) === "") {
        continue;
      }
      const number = numberOf(at("number"));
      const date = dateOf(at("date"), book.date1904);
      const name = textOf(at("name"));
      const invalid = (field: FicInvalidRow["field"]) => {
        summary.invalid.push({ line, kind: kind as "issued" | "received", field });
      };
      if (number === null) {
        invalid("number");
        continue;
      }
      if (date === null) {
        invalid("date");
        continue;
      }
      if (name === "") {
        invalid("name");
        continue;
      }
      const vat = optional(at("vat"));
      const taxCode = optional(at("taxCode"));
      const taxable = centsOf(at("taxable"));
      const tax = centsOf(at("tax"));
      const extras = (["rivalsa", "cassa", "otherCassa"] as const).map((c) => centsOf(at(c)));
      if (taxable === null || tax === null || extras.some((value) => value === null)) {
        invalid("amount");
        continue;
      }
      let total = taxable + tax + extras.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      const credit = total < 0;
      if (credit) total = -total;
      if (kind === "issued") {
        summary.issued.push({
          line,
          row: {
            documentType: credit ? "TD04" : "TD01",
            number,
            date,
            currency: "EUR",
            totalCents: total,
            customer: {
              name,
              vatCountry: vat !== null && /^\d{11}$/.test(vat) ? "IT" : null,
              vatCode: vat,
              taxCode,
            },
          },
        });
      } else {
        summary.received.push({
          line,
          row: {
            supplierName: name,
            supplierVat: vat ?? taxCode,
            number,
            issueDate: date,
            documentType: credit ? "TD04" : "TD01",
            currency: "EUR",
            totalCents: total,
          },
        });
      }
    }
    if (found) return summary;
  }
  return null;
}

/** First and last year of the dates found, or null without any. */
export function yearRange(summary: FicSummary): { from: number; to: number } | null {
  const years = [
    ...summary.issued.map((item) => item.row.date),
    ...summary.received.map((item) => item.row.issueDate),
  ].map((date) => Number(date.slice(0, 4)));
  return years.length === 0 ? null : { from: Math.min(...years), to: Math.max(...years) };
}

/** The prefix and suffix around the last digit group of a printed number, e.g. `7/CH`. */
function splitNumber(raw: string): { prefix: string; suffix: string } | null {
  const match = /^(.*?)(\d{1,9})(\D*)$/.exec(raw);
  if (!match) return null;
  const [, prefix = "", , suffix = ""] = match;
  return prefix === "" && suffix === "" ? null : { prefix, suffix };
}

const seriesName = (prefix: string, suffix: string): string => {
  const base = `${prefix}${suffix}`.replace(/[^A-Za-z0-9]+/g, " ").trim();
  return base || "Imported";
};

/**
 * The numbering series that the issued numbers need and the owner does not have yet: a number
 * with a prefix or suffix (`7/CH`, `A-12`) only blocks reuse inside a series with those affixes.
 * Existing series are never changed; an affix pair that fails the series rules is left out (such
 * a number is stored without a progressive).
 */
export function missingSeries(
  numbers: readonly string[],
  existing: readonly Pick<
    NumberingSeriesRecord,
    "id" | "prefix" | "suffix" | "isDefault" | "name"
  >[],
): NumberingSeriesData[] {
  const taken = new Set(existing.map((series) => series.name.toLowerCase()));
  const created = new Map<string, NumberingSeriesData>();
  for (const raw of new Set(numbers)) {
    const parts = splitNumber(raw);
    if (!parts) continue;
    const key = `${parts.prefix}\u0000${parts.suffix}`;
    if (created.has(key)) continue;
    // The series rules would trim a space; a number with one is not a plain affix number.
    if (!/^[A-Za-z0-9\-/.]*$/.test(parts.prefix + parts.suffix)) continue;
    const matched = matchSeries(raw, existing);
    const current = existing.find((series) => series.id === matched.seriesId);
    // Already inside a series with affixes: nothing to add.
    if (matched.progressive !== null && current && (current.prefix || current.suffix)) continue;
    let name = seriesName(parts.prefix, parts.suffix);
    for (let n = 2; taken.has(name.toLowerCase()); n++)
      name = `${seriesName(parts.prefix, parts.suffix)} ${n}`;
    const parsed = numberingSeriesInputSchema.safeParse({
      name,
      prefix: parts.prefix,
      suffix: parts.suffix,
    });
    if (!parsed.success) continue;
    taken.add(name.toLowerCase());
    created.set(key, parsed.data);
  }
  return [...created.values()];
}
