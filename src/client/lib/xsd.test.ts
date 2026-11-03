// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildFatturaXml } from "../../shared/fatturapa";
import { fixtureToFatturaInput } from "../../shared/fixtures/fatturapa";
import { INVOICE_FIXTURES } from "../../shared/fixtures/invoices";
import { checkFatturaXml } from "./xsd";

describe("browser XSD loader", () => {
  it("loads the vendored schema through Vite ?raw and validates real XML", async () => {
    const fixture = INVOICE_FIXTURES[0];
    if (!fixture) throw new Error("no fixture");
    const { xml } = buildFatturaXml(fixtureToFatturaInput(fixture, 3));
    expect((await checkFatturaXml(xml)).valid).toBe(true);

    const broken = xml.replace(/<Indirizzo>[^<]*<\/Indirizzo>/, "<Indirizzo></Indirizzo>");
    const check = await checkFatturaXml(broken);
    expect(check.valid).toBe(false);
    expect(check.mapped.problems.length + check.mapped.technical.length).toBeGreaterThan(0);
  });

  it("accepts a series number with a prefix or suffix, up to 20 basic Latin characters", async () => {
    const fixture = INVOICE_FIXTURES[0];
    if (!fixture) throw new Error("no fixture");
    const base = fixtureToFatturaInput(fixture, 3);
    for (const number of ["CH-3", "3/CH", "AB.12/2026-X", "ABCDEF123456789/GHIJ"]) {
      expect(number.length).toBeLessThanOrEqual(20);
      const { xml } = buildFatturaXml({ ...base, number });
      expect(xml).toContain(`<Numero>${number}</Numero>`);
      expect((await checkFatturaXml(xml)).valid, number).toBe(true);
    }
  });
});
