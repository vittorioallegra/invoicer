import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFatturaXml, parseFatturaXml } from "../src/shared/fatturapa";
import { validateFatturaXml, type XsdAssets } from "../src/shared/fatturapa/validate";
import {
  FIXTURE_ISSUE_DATE,
  FIXTURE_ISSUER,
  FIXTURE_NUMBER,
  fixtureToFatturaInput,
} from "../src/shared/fixtures/fatturapa";
import { INVOICE_FIXTURES } from "../src/shared/fixtures/invoices";
import { dueDate, type PaymentTerms } from "../src/shared/payment-terms";
import { NATURA_CODES, NATURA_TEXTS } from "../src/shared/totals";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const assets: XsdAssets = {
  schema: read("../assets/xsd/Schema_VFPR12_v1.2.3.xsd"),
  xmldsig: read("../assets/xsd/xmldsig-core-schema.xsd"),
};

const cents = (text: string | null | undefined) => Math.round(Number(text) * 100);
const fixture = (id: string) => {
  const found = INVOICE_FIXTURES.find((item) => item.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return found;
};

describe("AC 6: fixtures (a)-(g) produce XML that passes the official XSD", () => {
  for (const item of INVOICE_FIXTURES) {
    it(`(${item.id}) ${item.title}`, async () => {
      const input = fixtureToFatturaInput(item, 7);
      const { xml, fileName, totals } = buildFatturaXml(input);

      const result = await validateFatturaXml(xml, assets);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
      expect(fileName).toBe("IT12345678903_00007.xml");

      // Totals equal the expected values to the cent, in the document currency; the USD
      // fixture is converted to euro, so its totals are checked against the rate below.
      if (item.currency === "EUR") {
        expect(totals).toMatchObject({
          contributionCents: item.expected.contributionCents,
          taxableCents: item.expected.taxableCents,
          vatCents: item.expected.vatCents,
          ritenutaCents: item.expected.ritenutaCents,
          stampCents: item.expected.stampCents,
          documentTotalCents: item.expected.documentTotalCents,
          amountDueCents: item.expected.amountDueCents,
        });
      }

      // The written XML says the same as the totals (read back through the parser).
      const parsed = parseFatturaXml(xml);
      const doc = parsed.documents[0];
      expect(doc?.total).not.toBeNull();
      expect(cents(doc?.total)).toBe(totals.documentTotalCents);
      expect(cents(doc?.payments[0]?.amount)).toBe(totals.amountDueCents);
      expect(parsed.transmission.progressive).toBe("00007");
      expect(doc?.documentType).toBe(item.documentType);
      expect(doc?.currency).toBe(item.currency);
    });
  }
});

describe("fixture specifics", () => {
  const build = (id: string) => buildFatturaXml(fixtureToFatturaInput(fixture(id)));

  it("(a) rivalsa INPS is TC22 and the ritenuta is in DatiRitenuta", () => {
    const { xml } = build("a");
    expect(xml).toContain("<TipoCassa>TC22</TipoCassa>");
    expect(xml).toContain("<AlCassa>4.00</AlCassa>");
    expect(xml).toContain("<ImportoContributoCassa>67.59</ImportoContributoCassa>");
    expect(xml).toContain("<ImponibileCassa>1689.75</ImponibileCassa>");
    expect(xml).toContain("<Ritenuta>SI</Ritenuta>");
    expect(xml).toContain("<TipoRitenuta>RT01</TipoRitenuta>");
    expect(xml).toContain("<ImportoRitenuta>351.47</ImportoRitenuta>");
    expect(xml).toContain("<AliquotaRitenuta>20.00</AliquotaRitenuta>");
    expect(xml).toContain("<CausalePagamento>A</CausalePagamento>");
    expect(xml).toContain("<ImponibileImporto>1757.34</ImponibileImporto>");
    expect(xml).toContain("<Imposta>386.61</Imposta>");
  });

  it("(b) forfettario with bollo and the N2.2 legal text", () => {
    const { xml } = build("b");
    expect(xml).toContain("<RegimeFiscale>RF19</RegimeFiscale>");
    expect(xml).toContain("<BolloVirtuale>SI</BolloVirtuale>");
    expect(xml).toContain("<ImportoBollo>2.00</ImportoBollo>");
    expect(xml).toContain("<Natura>N2.2</Natura>");
    expect(xml).toContain(
      "<RiferimentoNormativo>Operazione effettuata ai sensi dell&apos;art. 1, commi 54-89, L. 190/2014</RiferimentoNormativo>",
    );
    // A private person is identified by the codice fiscale only.
    expect(xml).toContain("<CodiceFiscale>RSSMRA80A01H501U</CodiceFiscale>");
    const customer = xml.slice(xml.indexOf("<CessionarioCommittente>"));
    expect(customer).not.toContain("<IdFiscaleIVA>");
  });

  it("(c) EU client: foreign id without the country prefix, XXXXXXX and CAP 00000", () => {
    const { xml } = build("c");
    expect(xml).toContain("<IdPaese>DE</IdPaese>");
    expect(xml).toContain("<IdCodice>123456789</IdCodice>");
    expect(xml).toContain("<CodiceDestinatario>XXXXXXX</CodiceDestinatario>");
    expect(xml).toContain("<CAP>00000</CAP>");
    expect(xml).toContain("<Natura>N2.1</Natura>");
  });

  it("(d) a USD invoice is written in USD with the fixture's own totals", () => {
    const { xml, totals } = build("d");
    expect(totals).toMatchObject({
      currency: "USD",
      taxableCents: fixture("d").expected.taxableCents,
      documentTotalCents: fixture("d").expected.documentTotalCents,
      stampCents: 0,
    });
    expect(xml).toContain("<Divisa>USD</Divisa>");
    expect(xml).toContain("<PrezzoTotale>2500.00</PrezzoTotale>");
    expect(xml).toContain("<PrezzoTotale>1439.97</PrezzoTotale>");
    expect(xml).not.toContain("AltriDatiGestionali");
    expect(xml).not.toContain("<Causale>");
  });

  it("(e) cassa TC04 is subject to VAT but not to the ritenuta", () => {
    const { xml } = build("e");
    expect(xml).toContain("<TipoCassa>TC04</TipoCassa>");
    expect(xml).toContain("<ImportoContributoCassa>180.76</ImportoContributoCassa>");
    expect(xml).toContain("<AliquotaIVA>22.00</AliquotaIVA>");
    const cassa = xml.slice(
      xml.indexOf("<DatiCassaPrevidenziale>"),
      xml.indexOf("</DatiCassaPrevidenziale>"),
    );
    expect(cassa).not.toContain("<Ritenuta>");
    expect(xml).toContain("<ImportoRitenuta>903.81</ImportoRitenuta>");
  });

  it("(f) the included rivalsa is split per line: base on the line, contribution in the cassa block", () => {
    const f1 = build("f1").xml;
    expect(f1).toContain("<PrezzoTotale>1000.00</PrezzoTotale>");
    expect(f1).toContain("<ImportoContributoCassa>40.00</ImportoContributoCassa>");
    expect(f1).toContain("<ImponibileImporto>1040.00</ImponibileImporto>");
    const f2 = build("f2").xml;
    expect(f2).toContain("<PrezzoTotale>961.53</PrezzoTotale>");
    expect(f2).toContain("<ImportoContributoCassa>38.46</ImportoContributoCassa>");
    expect(f2).toContain("<ImponibileImporto>999.99</ImponibileImporto>");
  });

  it("(g) the credit note references fixture (a) in DatiFattureCollegate", () => {
    const { xml } = build("g");
    expect(xml).toContain("<TipoDocumento>TD04</TipoDocumento>");
    expect(xml).toContain(
      "<DatiFattureCollegate>\n        <IdDocumento>1</IdDocumento>\n        <Data>2026-03-15</Data>",
    );
    expect(FIXTURE_NUMBER).not.toBe("1");
    expect(FIXTURE_ISSUE_DATE).toBe("2026-04-20");
    expect(FIXTURE_ISSUER.vatNumber).toBe("12345678903");
  });
});

describe("natura legal texts", () => {
  it("fit the XSD for every natura code, with the full text kept in Causale when shortened", async () => {
    for (const natura of NATURA_CODES) {
      const input = fixtureToFatturaInput(fixture("c"));
      const text = NATURA_TEXTS[natura].text;
      const lines = input.invoice.lines.map((line) => ({ ...line, natura }));
      const { xml } = buildFatturaXml({
        ...input,
        invoice: {
          ...input.invoice,
          lines,
          data: { ...input.invoice.data, naturaTexts: { [natura]: text } },
        },
      });
      const result = await validateFatturaXml(xml, assets);
      expect(result.errors, natura).toEqual([]);
      const reference = (
        /<RiferimentoNormativo>(.*)<\/RiferimentoNormativo>/.exec(xml)?.[1] ?? ""
      ).replaceAll("&apos;", "'");
      expect(reference.length, natura).toBeLessThanOrEqual(100);
      if (text.length > 100) {
        const causali = [...xml.matchAll(/<Causale>(.*)<\/Causale>/g)].map((m) => m[1]).join(" ");
        expect(causali.replaceAll("&apos;", "'"), natura).toBe(text);
      }
    }
  });
});

describe("text that the XSD would refuse", () => {
  it("is made Latin-1 safe by the builder", async () => {
    const input = fixtureToFatturaInput(fixture("a"));
    const lines = input.invoice.lines.map((line, index) =>
      index === 0 ? { ...line, description: "Consulting – “phase 1” €100\nsecond line ł" } : line,
    );
    const { xml } = buildFatturaXml({ ...input, invoice: { ...input.invoice, lines } });
    expect((await validateFatturaXml(xml, assets)).errors).toEqual([]);
    expect(xml).toContain("Consulting - &quot;phase 1&quot; EUR100 second line l");
  });

  it("reports a schema violation instead of passing it", async () => {
    const { xml } = buildFatturaXml(fixtureToFatturaInput(fixture("a")));
    const broken = xml.replace("<CAP>00100</CAP>", "<CAP>1</CAP>");
    const result = await validateFatturaXml(broken, assets);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain("CAP");
  });
});

describe("payment terms", () => {
  const withTerms = (terms: PaymentTerms | null, dueDateCustom = false) => {
    const input = fixtureToFatturaInput(fixture("a"));
    return {
      ...input,
      issueDate: "2026-11-10",
      invoice: {
        ...input.invoice,
        dueDate: terms ? dueDate("2026-11-10", terms) : "2026-12-05",
        data: {
          ...input.invoice.data,
          payment: { ...input.invoice.data.payment, terms, dueDateCustom },
        },
      },
    };
  };

  it("writes the days, the reference date and the due date, and validates", async () => {
    const df = buildFatturaXml(withTerms({ kind: "custom", days: 30 })).xml;
    expect((await validateFatturaXml(df, assets)).errors).toEqual([]);
    expect(df).toContain(
      "<DataRiferimentoTerminiPagamento>2026-11-10</DataRiferimentoTerminiPagamento>",
    );
    expect(df).toContain("<GiorniTerminiPagamento>30</GiorniTerminiPagamento>");
    expect(df).toContain("<DataScadenzaPagamento>2026-12-10</DataScadenzaPagamento>");

    const zero = buildFatturaXml(withTerms({ kind: "custom", days: 0 })).xml;
    expect((await validateFatturaXml(zero, assets)).errors).toEqual([]);
    expect(zero).toContain("<GiorniTerminiPagamento>0</GiorniTerminiPagamento>");

    const dueOnly = {
      invoice_date: "2026-11-10",
      eom_15: "2026-12-15",
      eom_30: "2026-12-31",
      eom_60: "2027-01-31",
    } as const;
    for (const [kind, due] of Object.entries(dueOnly)) {
      const xml = buildFatturaXml(withTerms({ kind: kind as keyof typeof dueOnly })).xml;
      expect((await validateFatturaXml(xml, assets)).errors).toEqual([]);
      expect(xml).not.toContain("DataRiferimentoTerminiPagamento");
      expect(xml).not.toContain("GiorniTerminiPagamento");
      expect(xml).toContain(`<DataScadenzaPagamento>${due}</DataScadenzaPagamento>`);
    }
  });

  it("writes only the due date when there are no terms or the date was set by hand", () => {
    for (const xml of [
      buildFatturaXml(withTerms(null)).xml,
      buildFatturaXml(withTerms({ kind: "custom", days: 30 }, true)).xml,
    ]) {
      expect(xml).not.toContain("GiorniTerminiPagamento");
      expect(xml).not.toContain("DataRiferimentoTerminiPagamento");
      expect(xml).toContain("<DataScadenzaPagamento>");
    }
  });
});
