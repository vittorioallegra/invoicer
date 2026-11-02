/**
 * Hand-written message shapes for PEC and SdI mail (not recordings of real traffic; replace or
 * extend them with real, anonymised messages once the spike shows them). Used by parser tests
 * and by the spike's CPU probes. Contains a non-ASCII character so byte and character counts
 * differ.
 */

const crlf = (lines: readonly string[]) => lines.join("\r\n");

const RC_XML =
  '<?xml version="1.0" encoding="UTF-8"?><types:RicevutaConsegna xmlns:types="http://www.fatturapa.gov.it/sdi/messaggi/v1.0" versione="1.0"><IdentificativoSdI>12345</IdentificativoSdI><NomeFile>IT01234567890_00001.xml</NomeFile><DataOraRicezione>2026-11-02T09:15:00.000+01:00</DataOraRicezione><DataOraConsegna>2026-11-02T09:16:00.000+01:00</DataOraConsegna></types:RicevutaConsegna>';

/** The SdI message itself (what `postacert.eml` carries): a text part plus the RC receipt XML. */
export const SDI_RECEIPT_SOURCE = crlf([
  "From: sdi01@pec.fatturapa.it",
  "To: owner@pec.example",
  "Subject: CONSEGNA: IT01234567890_00001.xml",
  "Message-ID: <abc@sdi.fatturapa.it>",
  "Date: Mon, 02 Nov 2026 09:16:30 +0100",
  'Content-Type: multipart/mixed; boundary="inner"',
  "",
  "--inner",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Ricevuta di consegna del file IT01234567890_00001.xml",
  "--inner",
  'Content-Type: application/xml; name="IT01234567890_00001_RC_001.xml"',
  'Content-Disposition: attachment; filename="IT01234567890_00001_RC_001.xml"',
  "",
  RC_XML,
  "--inner--",
  "",
]);

/**
 * A PEC transport envelope as a provider delivers an SdI message: a human-readable part,
 * `daticert.xml` and `postacert.eml` (the original message, here the SdI receipt).
 */
export const PEC_RECEIPT_SOURCE = crlf([
  "Message-ID: <opec2-0001@pec.aruba.it>",
  "From: Per conto di: sdi01@pec.fatturapa.it <posta-certificata@pec.aruba.it>",
  "To: owner@pec.example",
  "Subject: POSTA CERTIFICATA: CONSEGNA: IT01234567890_00001.xml",
  "Date: Mon, 02 Nov 2026 09:16:30 +0100",
  "X-Ricevuta: non-accettazione",
  "X-Trasporto: posta-certificata",
  'Content-Type: multipart/mixed; boundary="env"',
  "",
  "--env",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Messaggio di posta certificata. Il giorno 02/11/2026 è stato consegnato.",
  "--env",
  'Content-Type: application/xml; name="daticert.xml"',
  'Content-Disposition: inline; filename="daticert.xml"',
  "",
  '<?xml version="1.0" encoding="UTF-8"?><postacert tipo="posta-certificata" errore="nessuno"><intestazione><mittente>sdi01@pec.fatturapa.it</mittente></intestazione><dati><identificativo>opec2-0001@pec.aruba.it</identificativo><msgid>&lt;abc@sdi.fatturapa.it&gt;</msgid></dati></postacert>',
  "--env",
  'Content-Type: message/rfc822; name="postacert.eml"',
  'Content-Disposition: inline; filename="postacert.eml"',
  "",
  SDI_RECEIPT_SOURCE,
  "--env--",
  "",
]);

/**
 * A PEC envelope carrying a received invoice: `postacert.eml` with a base64 XML attachment of
 * about `attachmentBytes` bytes (an invoice with many lines), for the worst-case CPU probe.
 */
export function pecInvoiceEnvelope(attachmentBytes = 100_000): string {
  const line =
    "<DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Line item</Descrizione><PrezzoUnitario>10.00</PrezzoUnitario><PrezzoTotale>10.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee>\n";
  let xml = '<?xml version="1.0" encoding="UTF-8"?><p:FatturaElettronica versione="FPR12">\n';
  while (xml.length < attachmentBytes) xml += line;
  xml += "</p:FatturaElettronica>";
  const base64 = (btoa(xml).match(/.{1,76}/g) ?? []).join("\r\n");
  const inner = crlf([
    "From: fornitore@pec.example",
    "To: owner@pec.example",
    "Subject: Invio fattura",
    "Message-ID: <inv@pec.example>",
    'Content-Type: multipart/mixed; boundary="inner"',
    "",
    "--inner",
    "Content-Type: text/plain",
    "",
    "In allegato la fattura.",
    "--inner",
    'Content-Type: application/xml; name="IT09876543211_00007.xml"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="IT09876543211_00007.xml"',
    "",
    base64,
    "--inner--",
    "",
  ]);
  return crlf([
    "Message-ID: <opec2-0002@pec.aruba.it>",
    "From: Per conto di: fornitore@pec.example <posta-certificata@pec.aruba.it>",
    "To: owner@pec.example",
    "Subject: POSTA CERTIFICATA: Invio fattura",
    "Date: Mon, 02 Nov 2026 10:00:00 +0100",
    "X-Trasporto: posta-certificata",
    'Content-Type: multipart/mixed; boundary="env"',
    "",
    "--env",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Messaggio di posta certificata.",
    "--env",
    'Content-Type: application/xml; name="daticert.xml"',
    "",
    '<?xml version="1.0" encoding="UTF-8"?><postacert tipo="posta-certificata" errore="nessuno"/>',
    "--env",
    'Content-Type: message/rfc822; name="postacert.eml"',
    'Content-Disposition: inline; filename="postacert.eml"',
    "",
    inner,
    "--env--",
    "",
  ]);
}
