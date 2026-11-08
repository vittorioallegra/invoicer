/** Invented FatturaPA files for the import tests (no real data). */

export interface TestXmlOptions {
  supplierVat?: string;
  customerName?: string;
  customerVat?: string;
  type?: string;
  number?: string;
  date?: string;
  /** Raw XML placed in `DatiGeneraliDocumento` after `Numero` (DatiRitenuta, DatiBollo, DatiCassa..., Causale). */
  general?: string;
  /** Raw `DettaglioLinee` elements; one 100.00 line with 22% VAT by default. */
  lines?: string;
  payment?: string;
}

export const testLine = (
  n: number,
  description: string,
  price: string,
  extra: {
    quantity?: string;
    total?: string;
    rate?: string;
    natura?: string;
    ritenuta?: boolean;
  } = {},
): string => `<DettaglioLinee>
  <NumeroLinea>${n}</NumeroLinea><Descrizione>${description}</Descrizione>
  <Quantita>${extra.quantity ?? "1.00"}</Quantita><UnitaMisura>pz</UnitaMisura>
  <PrezzoUnitario>${price}</PrezzoUnitario><PrezzoTotale>${extra.total ?? price}</PrezzoTotale>
  <AliquotaIVA>${extra.rate ?? "22.00"}</AliquotaIVA>${extra.natura ? `<Natura>${extra.natura}</Natura>` : ""}${extra.ritenuta ? "<Ritenuta>SI</Ritenuta>" : ""}
</DettaglioLinee>`;

export function testXml(options: TestXmlOptions = {}): string {
  const supplier = options.supplierVat ?? "01234567890";
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>${supplier}</IdCodice></IdTrasmittente>
      <ProgressivoInvio>1</ProgressivoInvio><FormatoTrasmissione>FPR12</FormatoTrasmissione>
      <CodiceDestinatario>0000000</CodiceDestinatario>
    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${supplier}</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>Test Supplier</Denominazione></Anagrafica>
        <RegimeFiscale>RF01</RegimeFiscale>
      </DatiAnagrafici>
      <Sede><Indirizzo>Via Prova 1</Indirizzo><CAP>00100</CAP><Comune>Roma</Comune><Provincia>RM</Provincia><Nazione>IT</Nazione></Sede>
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${options.customerVat ?? "09876543210"}</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>${options.customerName ?? "Test Customer"}</Denominazione></Anagrafica>
      </DatiAnagrafici>
      <Sede><Indirizzo>Via Altra 2</Indirizzo><CAP>10100</CAP><Comune>Torino</Comune><Provincia>TO</Provincia><Nazione>IT</Nazione></Sede>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>${options.type ?? "TD01"}</TipoDocumento><Divisa>EUR</Divisa>
        <Data>${options.date ?? "2025-03-31"}</Data><Numero>${options.number ?? "1"}</Numero>
        ${options.general ?? ""}
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi>
      ${options.lines ?? testLine(1, "Consulting", "100.00")}
      <DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>100.00</ImponibileImporto><Imposta>22.00</Imposta></DatiRiepilogo>
    </DatiBeniServizi>
    ${options.payment ?? ""}
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;
}
