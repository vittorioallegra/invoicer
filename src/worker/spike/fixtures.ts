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

/** Sample Openapi `supplier-invoice` callback (shape from the SDI OAS), 40 invoice lines. */
export function sampleCallbackPayload(lines = 40): string {
  const dettaglio = Array.from({ length: lines }, (_, i) => ({
    numero_linea: i + 1,
    descrizione: `Line item ${i + 1}`,
    quantita: "1.00",
    prezzo_unitario: "10.00",
    prezzo_totale: "10.00",
    aliquota_iva: "22.00",
  }));
  return JSON.stringify({
    event: "supplier-invoice",
    data: {
      invoice: {
        uuid: "ffe8cdad-1a02-49fe-8cc6-f6b189eb6e5d",
        created_at: "2026-11-02T10:32:19+00:00",
        filename: "IT12345678901_00001.xml",
        file_id: 335228642533,
        payload: {
          fattura_elettronica_header: {
            dati_trasmissione: {
              id_trasmittente: { id_paese: "IT", id_codice: "12345678901" },
              progressivo_invio: "00001",
              formato_trasmissione: "FPR12",
              codice_destinatario: "1234567",
            },
            cedente_prestatore: {
              dati_anagrafici: {
                id_fiscale_iva: { id_paese: "IT", id_codice: "12345678901" },
                anagrafica: { denominazione: "Supplier Srl" },
                regime_fiscale: "RF01",
              },
              sede: {
                indirizzo: "Via di Qua, 1",
                cap: "20145",
                comune: "Milano",
                provincia: "MI",
                nazione: "IT",
              },
            },
            cessionario_committente: {
              dati_anagrafici: {
                id_fiscale_iva: { id_paese: "IT", id_codice: "09876543211" },
                anagrafica: { denominazione: "Owner" },
              },
              sede: {
                indirizzo: "Via di La, 2",
                cap: "20145",
                comune: "Milano",
                provincia: "MI",
                nazione: "IT",
              },
            },
          },
          fattura_elettronica_body: [
            {
              dati_generali: {
                dati_generali_documento: {
                  tipo_documento: "TD01",
                  divisa: "EUR",
                  data: "2026-11-02",
                  numero: "1",
                },
              },
              dati_beni_servizi: {
                dettaglio_linee: dettaglio,
                dati_riepilogo: [
                  {
                    aliquota_iva: "22.00",
                    imponibile_importo: String(lines * 10),
                    imposta: (lines * 2.2).toFixed(2),
                  },
                ],
              },
            },
          ],
        },
      },
    },
  });
}
