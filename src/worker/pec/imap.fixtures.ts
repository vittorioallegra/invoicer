import { literal, type ScriptStep } from "./fake-socket";

/**
 * Hand-written IMAP transcripts modelled on RFC 3501 / RFC 9208 examples and the message shapes
 * documented for PEC and SdI. They are NOT recordings of the real Aruba server: the spike's PEC
 * probe (docs/notes/spike.md) shows the real greeting, capabilities and quota reply, and real
 * transcripts replace these where they differ. Test support only: never imported by Worker code.
 */

export const GREETING = "* OK [CAPABILITY IMAP4rev1 QUOTA] Dovecot ready.\r\n";

const crlf = (lines: readonly string[]) => `${lines.join("\r\n")}\r\n`;

const LOGIN_OK: ScriptStep = {
  expect: 'A1 LOGIN "owner@pec.example" "s3cret-pw"',
  reply: "A1 OK [CAPABILITY IMAP4rev1 QUOTA] Logged in\r\n",
};

export const EXAMINE_REPLY = crlf([
  "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)",
  "* 23 EXISTS",
  "* 0 RECENT",
  "* OK [UIDVALIDITY 3857529045] UIDs valid",
  "* OK [UIDNEXT 4392] Predicted next UID",
  "A2 OK [READ-ONLY] Examine completed",
]);

const EXAMINE: ScriptStep = { expect: 'A2 EXAMINE "INBOX"', reply: EXAMINE_REPLY };

export const POLL_TRANSCRIPT: ScriptStep[] = [
  LOGIN_OK,
  EXAMINE,
  // Nothing new: the server still returns the last UID for `n:*`.
  { expect: "A3 UID SEARCH UID 4392:*", reply: crlf(["* SEARCH 4391", "A3 OK Search completed"]) },
  {
    expect: "A4 UID SEARCH UID 4389:*",
    reply: crlf(["* SEARCH 4389 4390 4391", "A4 OK Search completed"]),
  },
  { expect: "A5 LOGOUT", reply: crlf(["* BYE Logging out", "A5 OK Logout completed"]) },
];

const headers = (id: string, from: string, subject: string) =>
  `Message-ID: <${id}>\r\nFrom: ${from}\r\nSubject: ${subject}\r\nDate: Mon, 02 Nov 2026 09:15:00 +0100\r\n\r\n`;

export const FETCH_SUMMARIES_TRANSCRIPT: ScriptStep[] = [
  LOGIN_OK,
  EXAMINE,
  {
    expect:
      /^A3 UID FETCH 4389,4390 \(UID RFC822\.SIZE FLAGS INTERNALDATE BODY\.PEEK\[HEADER\.FIELDS/,
    reply:
      `* 1 FETCH (UID 4389 RFC822.SIZE 5120 FLAGS (\\Seen) INTERNALDATE "02-Nov-2026 09:15:01 +0100" ` +
      `BODY[HEADER.FIELDS (MESSAGE-ID FROM SUBJECT DATE)] ${literal(headers("a1@pec.aruba.it", "posta-certificata@pec.aruba.it", "ACCETTAZIONE: fattura"))})\r\n` +
      `* 2 FETCH (UID 4390 RFC822.SIZE 48211 FLAGS () INTERNALDATE "02-Nov-2026 09:16:30 +0100" ` +
      `BODY[HEADER.FIELDS (MESSAGE-ID FROM SUBJECT DATE)] ${literal(headers("abc@sdi.fatturapa.it", "sdi01@pec.fatturapa.it", "CONSEGNA: IT01234567890_00001.xml"))})\r\n` +
      "A3 OK Fetch completed\r\n",
  },
];

/**
 * A PEC transport envelope as a provider delivers an SdI message: daticert.xml plus
 * postacert.eml, which carries the SdI receipt (RC) as an XML attachment. Contains a non-ASCII
 * character so byte and character counts differ.
 */
export const PEC_RECEIPT_SOURCE = [
  "Message-ID: <opec2-0001@pec.aruba.it>",
  "From: Per conto di: sdi01@pec.fatturapa.it <posta-certificata@pec.aruba.it>",
  "To: owner@pec.example",
  "Subject: POSTA CERTIFICATA: Ricevuta di consegna IT01234567890_00001.xml",
  "Date: Mon, 02 Nov 2026 09:16:30 +0100",
  "X-Ricevuta: pec ricevuta",
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
  '<?xml version="1.0" encoding="UTF-8"?><postacert tipo="posta-certificata" errore="nessuno"><intestazione><mittente>sdi01@pec.fatturapa.it</mittente></intestazione><dati><identificativo>opec2-0001@pec.aruba.it</identificativo><msgid>&lt;orig@pec.aruba.it&gt;</msgid></dati></postacert>',
  "--env",
  'Content-Type: message/rfc822; name="postacert.eml"',
  'Content-Disposition: inline; filename="postacert.eml"',
  "",
  "From: sdi01@pec.fatturapa.it",
  "To: owner@pec.example",
  "Subject: CONSEGNA: IT01234567890_00001.xml",
  "Message-ID: <abc@sdi.fatturapa.it>",
  'Content-Type: multipart/mixed; boundary="inner"',
  "",
  "--inner",
  "Content-Type: text/plain",
  "",
  "Ricevuta di consegna",
  "--inner",
  'Content-Type: application/xml; name="IT01234567890_00001_RC_001.xml"',
  'Content-Disposition: attachment; filename="IT01234567890_00001_RC_001.xml"',
  "",
  '<?xml version="1.0" encoding="UTF-8"?><types:RicevutaConsegna xmlns:types="http://www.fatturapa.gov.it/sdi/messaggi/v1.0" versione="1.0"><IdentificativoSdI>12345</IdentificativoSdI><NomeFile>IT01234567890_00001.xml</NomeFile><DataOraRicezione>2026-11-02T09:15:00.000+01:00</DataOraRicezione><DataOraConsegna>2026-11-02T09:16:00.000+01:00</DataOraConsegna></types:RicevutaConsegna>',
  "--inner--",
  "--env--",
  "",
].join("\r\n");

export const FETCH_SOURCE_TRANSCRIPT: ScriptStep[] = [
  LOGIN_OK,
  EXAMINE,
  {
    expect: "A3 UID FETCH 4390 (UID BODY.PEEK[])",
    reply: `* 2 FETCH (UID 4390 BODY[] ${literal(PEC_RECEIPT_SOURCE)})\r\nA3 OK Fetch completed\r\n`,
  },
  { expect: "A4 LOGOUT", reply: crlf(["* BYE", "A4 OK Logout completed"]) },
];

export const QUOTA_TRANSCRIPT: ScriptStep[] = [
  LOGIN_OK,
  {
    expect: 'A2 GETQUOTAROOT "INBOX"',
    reply: crlf([
      '* QUOTAROOT "INBOX" ""',
      '* QUOTA "" (STORAGE 12288 1048576)',
      "A2 OK Getquotaroot completed",
    ]),
  },
];

export const QUOTA_NO_SUPPORT_TRANSCRIPT: ScriptStep[] = [
  LOGIN_OK,
  { expect: 'A2 GETQUOTAROOT "INBOX"', reply: "A2 BAD Error in IMAP command GETQUOTAROOT\r\n" },
];

export const LOGIN_FAILED_TRANSCRIPT: ScriptStep[] = [
  {
    expect: 'A1 LOGIN "owner@pec.example" "s3cret-pw"',
    reply: "A1 NO [AUTHENTICATIONFAILED] Authentication failed.\r\n",
  },
];
