import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FatturaParseError, parseFatturaXml } from "../src/shared/fatturapa";
import { validateFatturaXml, type XsdAssets } from "../src/shared/fatturapa/validate";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const sample = (name: string) => read(`../src/shared/fatturapa/fixtures/${name}`);

// The official AdE sample files (fatturapa.gov.it, v1.2): one FPR12, one FPA12.
describe("received FatturaPA parser", () => {
  it("reads an FPA12 invoice for the public administration", () => {
    const invoice = parseFatturaXml(sample("IT01234567890_FPA01.xml"));
    expect(invoice.format).toBe("FPA12");
    expect(invoice.transmission).toMatchObject({
      idPaese: "IT",
      idCodice: "01234567890",
      progressive: "00001",
      recipientCode: "AAAAAA",
    });
    expect(invoice.supplier).toMatchObject({
      name: "ALPHA SRL",
      vatId: { country: "IT", code: "01234567890" },
      regimeFiscale: "RF19",
      address: { city: "SASSARI", province: "SS", postalCode: "07100" },
    });
    expect(invoice.customer).toMatchObject({ name: "AMMINISTRAZIONE BETA", vatId: null });
    expect(invoice.customer.taxCode).toBe("09876543210");
    const doc = invoice.documents[0];
    expect(doc).toMatchObject({
      documentType: "TD01",
      currency: "EUR",
      date: "2017-01-18",
      number: "123",
    });
    expect(doc?.causali).toHaveLength(2);
    expect(doc?.lines[0]).toMatchObject({
      number: "1",
      quantity: "5.00",
      unitPrice: "1.00",
      total: "5.00",
      vatRate: "22.00",
    });
    expect(doc?.vatSummary[0]).toMatchObject({ taxable: "5.00", vat: "1.10" });
    expect(doc?.payments[0]).toMatchObject({
      method: "MP01",
      amount: "6.10",
      dueDate: "2017-02-18",
    });
  });

  it("reads an FPR12 invoice for a private party", () => {
    const invoice = parseFatturaXml(sample("IT01234567890_FPR01.xml"));
    expect(invoice.format).toBe("FPR12");
    expect(invoice.documents).toHaveLength(1);
    expect(invoice.supplier.name).not.toBe("");
    expect(invoice.documents[0]?.lines.length).toBeGreaterThan(0);
    expect(invoice.documents[0]?.vatSummary.length).toBeGreaterThan(0);
  });

  it("keeps markup in text as text and rejects non-FatturaPA input", () => {
    const xml = sample("IT01234567890_FPA01.xml").replace(
      "DESCRIZIONE DELLA FORNITURA",
      "&lt;script&gt;alert(1)&lt;/script&gt; &amp; more",
    );
    expect(parseFatturaXml(xml).documents[0]?.lines[0]?.description).toBe(
      "<script>alert(1)</script> & more",
    );
    expect(() => parseFatturaXml("<html></html>")).toThrow(FatturaParseError);
    expect(() => parseFatturaXml("not xml at all")).toThrow(FatturaParseError);
  });

  it("the vendored schema accepts both official samples", async () => {
    const assets: XsdAssets = {
      schema: read("../assets/xsd/Schema_VFPR12_v1.2.3.xsd"),
      xmldsig: read("../assets/xsd/xmldsig-core-schema.xsd"),
    };
    for (const name of ["IT01234567890_FPA01.xml", "IT01234567890_FPR01.xml"]) {
      expect((await validateFatturaXml(sample(name), assets)).errors, name).toEqual([]);
    }
  });
});
