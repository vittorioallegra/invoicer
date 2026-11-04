// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countryCodeOf, guessMapping, parseCsv, previewRows } from "./clients-csv";

const csv = readFileSync(new URL("./fixtures/fic-clients.csv", import.meta.url), "utf8");

describe("Fatture in Cloud clients CSV (AC 17)", () => {
  it("reads the semicolon separated export and matches its columns by header", () => {
    const parsed = parseCsv(csv);
    expect(parsed.rows).toHaveLength(6);
    expect(parsed.headers).toContain("Indirizzo città");
    expect(guessMapping(parsed.headers)).toEqual({
      name: "Nome",
      vatNumber: "Partita IVA",
      taxCode: "Codice fiscale",
      address: "Indirizzo via",
      postalCode: "Indirizzo CAP",
      city: "Indirizzo città",
      province: "Indirizzo provincia",
      country: "Paese ISO",
      language: "Lingua",
      currency: "Valuta",
      recipientCode: "Codice destinatario",
      pec: "PEC",
      email: "Email",
    });
  });

  it("accepts every valid row and lists each invalid row with its problem", () => {
    const parsed = parseCsv(csv);
    const rows = previewRows(parsed, guessMapping(parsed.headers));
    expect(rows.filter((r) => r.client).map((r) => r.name)).toEqual([
      "Acme S.r.l.",
      "Beta S.p.A.",
      "Mario Rossi",
      "Hans Muster",
    ]);
    const invalid = rows.filter((r) => !r.client);
    expect(invalid.map((r) => [r.line, r.name, r.problems])).toEqual([
      [5, "Delta S.r.l.", [{ field: "vatNumber", code: "invalid_vat_number" }]],
      [
        7,
        "",
        [
          { field: "name", code: "required" },
          { field: "vatNumber", code: "required" },
        ],
      ],
    ]);
    // Types and defaults follow the data: a private person, a foreign company, the PDF language.
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.client]));
    expect(byName["Mario Rossi"]).toMatchObject({ type: "it_private", pdfLanguage: "it" });
    expect(byName["Hans Muster"]).toMatchObject({
      type: "non_eu_company",
      countryCode: "CH",
      currency: "CHF",
      pdfLanguage: "en",
    });
    expect(byName["Acme S.r.l."]).toMatchObject({ type: "it_company", recipientCode: "ABC1234" });
  });

  it("follows a changed column map and a comma separated file", () => {
    const parsed = parseCsv("Ragione,PI,Strada\nX Srl,01234567897,Via 1");
    expect(parsed.headers).toEqual(["Ragione", "PI", "Strada"]);
    const rows = previewRows(parsed, { name: "Ragione", vatNumber: "PI", address: "Strada" });
    expect(rows[0]?.client).toBeNull();
    expect(rows[0]?.problems.map((p) => p.field)).toEqual(["postalCode", "city", "province"]);
  });

  it("reads a country given by name", () => {
    expect(countryCodeOf("Italia")).toBe("IT");
    expect(countryCodeOf("Switzerland")).toBe("CH");
    expect(countryCodeOf("de")).toBe("DE");
    expect(countryCodeOf("")).toBe("IT");
  });
});
