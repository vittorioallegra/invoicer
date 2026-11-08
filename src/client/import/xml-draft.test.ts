import { describe, expect, it } from "vitest";
import { parseFatturaXml } from "../../shared/fatturapa";
import { testLine, testXml } from "./test-xml";
import { xmlDraftFromInvoice } from "./xml-draft";

const customer = {
  name: "Test Customer",
  vatCountry: "IT",
  vatCode: "09876543210",
  taxCode: null,
  client: null,
};
const draftOf = (xml: string) => xmlDraftFromInvoice(parseFatturaXml(xml), customer);

describe("xmlDraftFromInvoice", () => {
  it("keeps every line with quantity, unit, price, VAT rate and natura", () => {
    const draft = draftOf(
      testXml({
        lines:
          testLine(1, "Hours", "50.50", { quantity: "2.50", total: "126.25" }) +
          testLine(2, "Exempt", "10.00", { rate: "0.00", natura: "N2.2" }),
      }),
    );
    expect(draft?.lines).toEqual([
      {
        description: "Hours",
        note: "",
        quantityMilli: 2500,
        unit: "pz",
        unitPriceCents: 5050,
        vatRateBp: 2200,
        natura: null,
      },
      {
        description: "Exempt",
        note: "",
        quantityMilli: 1000,
        unit: "pz",
        unitPriceCents: 1000,
        vatRateBp: null,
        natura: "N2.2",
      },
    ]);
  });

  it("folds a line discount into the unit price so the total is kept", () => {
    const draft = draftOf(
      testXml({
        lines: testLine(1, "Discounted", "100.00", { quantity: "2.00", total: "180.00" }),
      }),
    );
    expect(draft?.lines[0]).toMatchObject({ quantityMilli: 2000, unitPriceCents: 9000 });
  });

  it("maps cassa, ritenuta, note and payment onto the editor options", () => {
    const draft = draftOf(
      testXml({
        general: `<DatiRitenuta><TipoRitenuta>RT01</TipoRitenuta><ImportoRitenuta>20.80</ImportoRitenuta><AliquotaRitenuta>20.00</AliquotaRitenuta><CausalePagamento>A</CausalePagamento></DatiRitenuta>
          <DatiCassaPrevidenziale><TipoCassa>TC22</TipoCassa><AlCassa>4.00</AlCassa><ImportoContributoCassa>4.00</ImportoContributoCassa><ImponibileCassa>100.00</ImponibileCassa><AliquotaIVA>22.00</AliquotaIVA><Ritenuta>SI</Ritenuta></DatiCassaPrevidenziale>
          <Causale>Project one</Causale>`,
        lines: testLine(1, "Work", "100.00", { ritenuta: true }),
        payment:
          "<DatiPagamento><CondizioniPagamento>TP02</CondizioniPagamento><DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>2025-04-30</DataScadenzaPagamento><ImportoPagamento>100.00</ImportoPagamento><IBAN>IT60X0542811101000000123456</IBAN></DettaglioPagamento></DatiPagamento>",
      }),
    );
    expect(draft).toMatchObject({
      cassa: { type: "rivalsa_inps", rateBp: 400, mode: "excluded", subjectToRitenuta: true },
      ritenuta: { type: "RT01", rateBp: 2000, baseBp: 10000, causale: "A" },
      bollo: "none",
      note: "Project one",
      payment: { method: "MP05", iban: "IT60X0542811101000000123456", dueDate: "2025-04-30" },
    });
  });

  it("derives a ritenuta base share below 100% from the withheld amount", () => {
    const draft = draftOf(
      testXml({
        general: `<DatiRitenuta><TipoRitenuta>RT01</TipoRitenuta><ImportoRitenuta>12.00</ImportoRitenuta><AliquotaRitenuta>20.00</AliquotaRitenuta><CausalePagamento>A</CausalePagamento></DatiRitenuta>`,
        lines: testLine(1, "Work", "100.00", { ritenuta: true }),
      }),
    );
    expect(draft?.ritenuta?.baseBp).toBe(6000);
  });

  it("leaves out what the editor cannot hold (unknown cause)", () => {
    const draft = draftOf(
      testXml({
        general: `<DatiRitenuta><TipoRitenuta>RT01</TipoRitenuta><ImportoRitenuta>20.00</ImportoRitenuta><AliquotaRitenuta>20.00</AliquotaRitenuta><CausalePagamento>QQ</CausalePagamento></DatiRitenuta>`,
      }),
    );
    expect(draft?.ritenuta).toBeNull();
  });

  it("turns a bollo line into the client-charged bollo and keeps an issuer bollo", () => {
    const stamp = testLine(2, "Imposta di bollo", "2.00", { rate: "0.00", natura: "N1" });
    const client = draftOf(
      testXml({
        general:
          "<DatiBollo><BolloVirtuale>SI</BolloVirtuale><ImportoBollo>2.00</ImportoBollo></DatiBollo>",
        lines: testLine(1, "Work", "100.00") + stamp,
      }),
    );
    expect(client?.bollo).toBe("client");
    expect(client?.lines).toHaveLength(1);
    const issuer = draftOf(
      testXml({
        general:
          "<DatiBollo><BolloVirtuale>SI</BolloVirtuale><ImportoBollo>2.00</ImportoBollo></DatiBollo>",
      }),
    );
    expect(issuer?.bollo).toBe("issuer");
  });

  it("refuses document types the editor does not create", () => {
    expect(draftOf(testXml({ type: "TD02" }))).toBeNull();
  });
});
