import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFatturaXml, mapXsdErrors } from "../src/shared/fatturapa";
import { validateFatturaXml, type XsdAssets } from "../src/shared/fatturapa/validate";
import { fixtureToFatturaInput } from "../src/shared/fixtures/fatturapa";
import { INVOICE_FIXTURES } from "../src/shared/fixtures/invoices";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const assets: XsdAssets = {
  schema: read("../assets/xsd/Schema_VFPR12_v1.2.3.xsd"),
  xmldsig: read("../assets/xsd/xmldsig-core-schema.xsd"),
};

const fixtureA = INVOICE_FIXTURES[0];
if (!fixtureA) throw new Error("fixture a");
const { xml } = buildFatturaXml(fixtureToFatturaInput(fixtureA));

async function mapBroken(broken: string) {
  expect(broken).not.toBe(xml);
  const result = await validateFatturaXml(broken, assets);
  expect(result.valid).toBe(false);
  return mapXsdErrors(broken, result.errors);
}

describe("XSD errors mapped to fields", () => {
  it("places a bad issuer postal code on the profile field", async () => {
    const mapped = await mapBroken(xml.replace("<CAP>00100</CAP>", "<CAP>1</CAP>"));
    expect(mapped.problems).toMatchObject([
      { field: "issuer.postalCode", kind: "invalid", index: null },
    ]);
    expect(mapped.technical).toEqual([]);
  });

  it("tells the client from the issuer by position, and empty from invalid", async () => {
    const mapped = await mapBroken(
      xml.replace("<Denominazione>Acme Srl</Denominazione>", "<Denominazione></Denominazione>"),
    );
    expect(mapped.problems).toMatchObject([{ field: "client.name", kind: "required" }]);
  });

  it("reports a too long text and the line it is on", async () => {
    const mapped = await mapBroken(
      xml.replace(
        "<Descrizione>Analysis (hours)</Descrizione>",
        `<Descrizione>${"x".repeat(1001)}</Descrizione>`,
      ),
    );
    expect(mapped.problems).toMatchObject([
      { field: "lines.description", index: 1, kind: "too_long" },
    ]);
  });

  it("turns a missing element into a required field", async () => {
    const mapped = await mapBroken(xml.replace(/ *<Comune>Milano<\/Comune>\n/, ""));
    expect(mapped.problems).toMatchObject([{ field: "client.city", kind: "required" }]);
  });

  it("maps payment, recipient code and enumeration errors", async () => {
    const iban = await mapBroken(xml.replace("IT60X0542811101000000123456", "XX"));
    expect(iban.problems).toMatchObject([{ field: "payment.iban", kind: "invalid" }]);
    const code = await mapBroken(
      xml.replace("<CodiceDestinatario>0000000", "<CodiceDestinatario>00"),
    );
    expect(code.problems).toMatchObject([{ field: "client.recipientCode", kind: "invalid" }]);
    const regime = await mapBroken(xml.replace("RF01", "RF99"));
    expect(regime.problems).toMatchObject([{ field: "issuer.regimeFiscale", kind: "invalid" }]);
  });

  it("keeps errors it cannot place under the technical details", async () => {
    const mapped = await mapBroken(
      xml.replace(
        "<NumeroLinea>1</NumeroLinea>",
        "<NumeroLinea>1</NumeroLinea><Surprise>1</Surprise>",
      ),
    );
    expect(mapped.problems).toEqual([]);
    expect(mapped.technical[0]).toContain("Surprise");
  });
});
