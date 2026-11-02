/**
 * Synthetic ES256 WebAuthn assertion (generated once with Node WebCrypto, throwaway key) used
 * to measure and test assertion verification without a device. RP ID `spike.example`.
 */
export const ASSERTION_FIXTURE = {
  rpID: "spike.example",
  origin: "https://spike.example",
  challenge: "Zml4dHVyZS1jaGFsbGVuZ2U",
  credentialID: "fixture-credential",
  counter: 7,
  publicKey:
    "pQECAyYgASFYING_Yk1BubPt_oWngmJsFfB1hTRuGZTn5Mcj0WZvGiW_Ilggxv402giAh92GJpnAMwISSysd3K0aurWV-qchyMFtwMc",
  response: {
    id: "fixture-credential",
    rawId: "fixture-credential",
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON:
        "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiWm1sNGRIVnlaUzFqYUdGc2JHVnVaMlUiLCJvcmlnaW4iOiJodHRwczovL3NwaWtlLmV4YW1wbGUiLCJjcm9zc09yaWdpbiI6ZmFsc2V9",
      authenticatorData: "fkHMuJBDBOX3ej49WbSqHdB8WKvfHv2jrvnZ49MeYZ0FAAAABw",
      signature:
        "MEUCIE-6MrIzh2EpYsWEpNUi0g3pGrSKDzmS1plFZVsy1NItAiEA4hHjAU4ZTmVX0X_dZfE3234DdNM9J7LZoo0Hhzf_X-E",
    },
  },
};

/** Static push subscription (public key + auth secret only, no private key) for encryption timing. */
export const PUSH_SUBSCRIPTION_FIXTURE = {
  endpoint: "https://push.example.invalid/send/fixture",
  keys: {
    p256dh:
      "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
  },
};

/** Minimal FatturaPA 1.2 sample (TD01, one 22 % line), for the PEC test message attachment. */
export function sampleInvoiceXml(opts: {
  fiscalId: string;
  recipientCode: string;
  progressive: string;
  number: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>${opts.fiscalId}</IdCodice></IdTrasmittente>
      <ProgressivoInvio>${opts.progressive}</ProgressivoInvio>
      <FormatoTrasmissione>FPR12</FormatoTrasmissione>
      <CodiceDestinatario>${opts.recipientCode}</CodiceDestinatario>
    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${opts.fiscalId}</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>Spike Test Srl</Denominazione></Anagrafica>
        <RegimeFiscale>RF01</RegimeFiscale>
      </DatiAnagrafici>
      <Sede><Indirizzo>Via di Qua, 1</Indirizzo><CAP>20145</CAP><Comune>Milano</Comune><Provincia>MI</Provincia><Nazione>IT</Nazione></Sede>
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>09876543211</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>Customer Spa</Denominazione></Anagrafica>
      </DatiAnagrafici>
      <Sede><Indirizzo>Via di La, 2</Indirizzo><CAP>20145</CAP><Comune>Milano</Comune><Provincia>MI</Provincia><Nazione>IT</Nazione></Sede>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>2026-11-02</Data><Numero>${opts.number}</Numero></DatiGeneraliDocumento></DatiGenerali>
    <DatiBeniServizi>
      <DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Spike service</Descrizione><PrezzoUnitario>10.00</PrezzoUnitario><PrezzoTotale>10.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee>
      <DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>10.00</ImponibileImporto><Imposta>2.20</Imposta><EsigibilitaIVA>I</EsigibilitaIVA></DatiRiepilogo>
    </DatiBeniServizi>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;
}
