import Papa from "papaparse";
import {
  type ClientInput,
  clientInputSchema,
  deriveClientType,
  newClientDefaults,
} from "../../shared/client";
import type { RowProblem } from "../../shared/import";

/**
 * Clients from a Fatture in Cloud CSV export: the file is read and mapped in the browser (the
 * columns are matched by header name and the owner can change each match on the preview), every
 * row is checked with the client rules, and rows that fail are listed with their problems instead
 * of being dropped silently.
 */

export const CSV_FIELDS = [
  "name",
  "vatNumber",
  "taxCode",
  "address",
  "postalCode",
  "city",
  "province",
  "country",
  "language",
  "currency",
  "recipientCode",
  "pec",
  "email",
] as const;
export type CsvField = (typeof CSV_FIELDS)[number];

/** A map from a client field to the CSV column (header) that feeds it; absent = not imported. */
export type ColumnMap = Partial<Record<CsvField, string>>;

/** Header names (lower case, accents and punctuation removed) tried in order for each field. */
const ALIASES: Record<CsvField, string[]> = {
  name: ["nome", "denominazione", "ragione sociale", "name", "company name", "cliente"],
  vatNumber: ["partita iva", "p iva", "piva", "vat number", "vat id", "vat"],
  taxCode: ["codice fiscale", "cod fiscale", "cf", "tax code", "fiscal code"],
  address: ["indirizzo via", "indirizzo", "via", "address", "street"],
  postalCode: ["indirizzo cap", "cap", "postal code", "zip", "zip code"],
  city: ["indirizzo citta", "citta", "comune", "city"],
  province: ["indirizzo provincia", "provincia", "prov", "province"],
  country: ["paese iso", "country code", "paese", "country", "nazione"],
  language: ["lingua", "language"],
  currency: ["valuta", "currency"],
  recipientCode: [
    "codice destinatario",
    "cod destinatario",
    "codice destinatario sdi",
    "cod destinatario sdi",
    "codice sdi",
    "recipient code",
  ],
  pec: ["pec", "indirizzo pec", "email pec"],
  email: ["email", "e mail", "indirizzo email", "mail"],
};

const normalize = (header: string) =>
  header
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/** Reads CSV text (the separator is detected: `;` for Italian Excel, `,` otherwise). */
export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });
  const headers = (result.meta.fields ?? []).filter((header) => header !== "");
  return { headers, rows: result.data };
}

/** Matches each field with the first column whose header is one of its names. */
export function guessMapping(headers: readonly string[]): ColumnMap {
  const normalized = headers.map((header) => [header, normalize(header)] as const);
  const map: ColumnMap = {};
  for (const field of CSV_FIELDS) {
    for (const alias of ALIASES[field]) {
      const match = normalized.find(([, name]) => name === alias);
      if (match) {
        map[field] = match[0];
        break;
      }
    }
  }
  return map;
}

/** ISO code of a country given as a code or as a name in Italian or English. */
export function countryCodeOf(value: string): string {
  const text = value.trim();
  if (text === "") return "IT";
  if (/^[A-Za-z]{2}$/.test(text)) return text.toUpperCase();
  const wanted = normalize(text);
  for (const language of ["it", "en"]) {
    const names = new Intl.DisplayNames([language], { type: "region" });
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        const name = names.of(code);
        if (name && name !== code && normalize(name) === wanted) return code;
      }
    }
  }
  return text.toUpperCase();
}

const PDF_LANGUAGES: Record<string, "it" | "en"> = {
  italiano: "it",
  italian: "it",
  it: "it",
  inglese: "en",
  english: "en",
  en: "en",
};

export interface CsvPreviewRow {
  /** 1-based line of the data row in the file (the header is line 1). */
  line: number;
  /** The client as it would be stored, when the row passes the client rules. */
  client: ClientInput | null;
  /** What the row breaks (empty when it is valid). */
  problems: RowProblem[];
  /** The name as read, to recognise the row on the preview. */
  name: string;
}

/** A client record from one CSV row and the column map. */
export function rowToClient(row: Record<string, string>, map: ColumnMap): ClientInput {
  const get = (field: CsvField) => (map[field] ? (row[map[field] as string] ?? "").trim() : "");
  const vatNumber = get("vatNumber");
  const taxCode = get("taxCode");
  const country = countryCodeOf(get("country"));
  const personal = vatNumber === "" && taxCode.replaceAll(/\s+/g, "").length === 16;
  const type = deriveClientType(personal ? "private" : "company", country);
  const language = PDF_LANGUAGES[normalize(get("language"))] ?? (country === "IT" ? "it" : "en");
  const recipient = get("recipientCode");
  return {
    type,
    name: get("name"),
    vatNumber: country === "IT" ? vatNumber : "",
    taxCode,
    foreignTaxId: country === "IT" ? "" : vatNumber,
    countryCode: country,
    address: get("address"),
    postalCode: get("postalCode"),
    city: get("city"),
    province: get("province"),
    recipientCode: recipient,
    pec: get("pec"),
    email: get("email"),
    pdfLanguage: language,
    currency: get("currency") || "EUR",
    defaults: newClientDefaults(type),
  };
}

/** Maps and checks every row; the preview shows the result and the import sends the valid ones. */
export function previewRows(parsed: ParsedCsv, map: ColumnMap): CsvPreviewRow[] {
  return parsed.rows.map((row, index) => {
    const client = rowToClient(row, map);
    const checked = clientInputSchema.safeParse(client);
    const problems: RowProblem[] = checked.success
      ? []
      : checked.error.issues.map((issue) => ({
          field: issue.path.join(".") || "name",
          code: String(issue.message),
        }));
    return {
      line: index + 2,
      client: checked.success ? client : null,
      problems,
      name: typeof client.name === "string" ? client.name : "",
    };
  });
}
