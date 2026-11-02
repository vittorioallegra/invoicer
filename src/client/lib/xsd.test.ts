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
});
