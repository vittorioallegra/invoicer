/**
 * Builders for the PEC and SdI messages the mailbox polling sees: provider receipts, SdI
 * messages (RC, NS, MC), the SdI's first reply, received invoices and unrelated mail. Hand-written
 * from the PEC rules (DPR 68/2005) and the SdI message schemas, not recordings of real traffic:
 * replace them with anonymised real messages after the first real send (AC 21). Test support only.
 */

const crlf = (lines: readonly string[]) => lines.join("\r\n");
const SDI_NS = "http://www.fatturapa.gov.it/sdi/messaggi/v1.0";
const xmlDecl = '<?xml version="1.0" encoding="UTF-8"?>';

export const OWNER_PEC = "owner@pec.example";
export const SDI_ADDRESS = "sdi01@pec.fatturapa.it";

const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const rcXml = (fileName: string) =>
  `${xmlDecl}<types:RicevutaConsegna xmlns:types="${SDI_NS}" versione="1.0"><IdentificativoSdI>12345</IdentificativoSdI><NomeFile>${fileName}</NomeFile><DataOraRicezione>2026-11-02T09:15:00.000+01:00</DataOraRicezione><DataOraConsegna>2026-11-02T09:16:00.000+01:00</DataOraConsegna></types:RicevutaConsegna>`;

export const mcXml = (fileName: string, description = "Destinatario non raggiungibile") =>
  `${xmlDecl}<types:NotificaMancataConsegna xmlns:types="${SDI_NS}" versione="1.0"><IdentificativoSdI>12346</IdentificativoSdI><NomeFile>${fileName}</NomeFile><DataOraRicezione>2026-11-02T09:15:00.000+01:00</DataOraRicezione><Descrizione>${escapeXml(description)}</Descrizione></types:NotificaMancataConsegna>`;

export const nsXml = (
  fileName: string,
  errors: readonly { code: string; description: string }[] = [
    { code: "00311", description: "Codice Destinatario non valido" },
  ],
) =>
  `${xmlDecl}<types:NotificaScarto xmlns:types="${SDI_NS}" versione="1.0"><IdentificativoSdI>12347</IdentificativoSdI><NomeFile>${fileName}</NomeFile><DataOraRicezione>2026-11-02T09:15:00.000+01:00</DataOraRicezione><ListaErrori>${errors
    .map(
      (e) =>
        `<Errore><Codice>${e.code}</Codice><Descrizione>${escapeXml(e.description)}</Descrizione></Errore>`,
    )
    .join("")}</ListaErrori><MessageId>999</MessageId></types:NotificaScarto>`;

const base64 = (text: string) => (btoa(text).match(/.{1,76}/g) ?? []).join("\r\n");

interface Attachment {
  name: string;
  content: string;
  encoding?: "base64" | "7bit";
}

/** A plain MIME message with attachments (what `postacert.eml` carries). */
function mime(headers: readonly string[], attachments: readonly Attachment[], boundary = "in") {
  const parts = attachments.flatMap((a) => [
    `--${boundary}`,
    `Content-Type: application/xml; name="${a.name}"`,
    `Content-Disposition: attachment; filename="${a.name}"`,
    ...(a.encoding === "base64" ? ["Content-Transfer-Encoding: base64"] : []),
    "",
    a.encoding === "base64" ? base64(a.content) : a.content,
  ]);
  return crlf([
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Messaggio.",
    ...parts,
    `--${boundary}--`,
    "",
  ]);
}

export interface EnvelopeOptions {
  /** `daticert.xml` type: what the PEC provider says this message is. */
  tipo: "posta-certificata" | "accettazione" | "avvenuta-consegna" | "errore-consegna";
  messageId: string;
  subject: string;
  from?: string;
  to?: string;
  /** Address the original message was addressed to (`destinatari` in `daticert.xml`). */
  recipient?: string;
  date?: string;
  /** Message-ID of the original message a receipt refers to (`msgid` and `X-Riferimento-Message-ID`). */
  refMessageId?: string;
  /** `postacert.eml`, the original message. */
  inner?: string;
}

/** A PEC transport envelope: human part, `daticert.xml` and, optionally, `postacert.eml`. */
export function pecEnvelope(o: EnvelopeOptions): string {
  const from = o.from ?? "posta-certificata@pec.aruba.it";
  const isReceipt = o.tipo !== "posta-certificata";
  const daticert = `${xmlDecl}<postacert tipo="${o.tipo}" errore="${o.tipo === "errore-consegna" ? "no-dest" : "nessuno"}"><intestazione><mittente>${escapeXml(from)}</mittente><destinatari tipo="certificato">${escapeXml(o.recipient ?? o.to ?? OWNER_PEC)}</destinatari><oggetto>${escapeXml(o.subject)}</oggetto></intestazione><dati><identificativo>opec-${o.messageId}</identificativo>${o.refMessageId ? `<msgid>${escapeXml(o.refMessageId)}</msgid>` : ""}</dati></postacert>`;
  const headers = [
    `Message-ID: <${o.messageId}>`,
    `From: ${isReceipt ? "" : "Per conto di: "}${from}`,
    `To: ${o.to ?? OWNER_PEC}`,
    `Subject: ${o.subject}`,
    `Date: ${o.date ?? "Mon, 02 Nov 2026 09:16:30 +0100"}`,
    "X-Trasporto: posta-certificata",
    ...(isReceipt ? [`X-Ricevuta: ${o.tipo}`] : []),
    ...(o.refMessageId ? [`X-Riferimento-Message-ID: ${o.refMessageId}`] : []),
    'Content-Type: multipart/mixed; boundary="env"',
  ];
  return crlf([
    ...headers,
    "",
    "--env",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Messaggio di posta certificata.",
    "--env",
    'Content-Type: application/xml; name="daticert.xml"',
    'Content-Disposition: inline; filename="daticert.xml"',
    "",
    daticert,
    ...(o.inner
      ? [
          "--env",
          'Content-Type: message/rfc822; name="postacert.eml"',
          'Content-Disposition: inline; filename="postacert.eml"',
          "",
          o.inner,
        ]
      : []),
    "--env--",
    "",
  ]);
}

/**
 * The provider's receipt for a message we sent. A complete receipt carries the original message
 * (our invoice file) as `postacert.eml`, so the file name is visible too.
 */
export function providerReceipt(o: {
  tipo: "accettazione" | "avvenuta-consegna" | "errore-consegna";
  id: string;
  /** Message-ID we sent (without angle brackets). */
  sent: string;
  fileName: string;
  to?: string;
  date?: string;
}): string {
  const label = {
    accettazione: "ACCETTAZIONE",
    "avvenuta-consegna": "CONSEGNA",
    "errore-consegna": "AVVISO DI MANCATA CONSEGNA",
  }[o.tipo];
  const original = mime(
    [
      `Message-ID: <${o.sent}>`,
      `From: ${OWNER_PEC}`,
      `To: ${o.to ?? SDI_ADDRESS}`,
      `Subject: Fattura ${o.fileName}`,
    ],
    [{ name: o.fileName, content: "<FatturaElettronica/>", encoding: "base64" }],
  );
  return pecEnvelope({
    tipo: o.tipo,
    messageId: o.id,
    subject: `${label}: Fattura ${o.fileName}`,
    recipient: o.to ?? SDI_ADDRESS,
    refMessageId: `<${o.sent}>`,
    date: o.date,
    inner: original,
  });
}

/** An SdI message (RC, NS, MC) as the PEC provider hands it over. */
export function sdiMessage(o: {
  type: "RC" | "NS" | "MC";
  id: string;
  fileName: string;
  /** Sender address of the SdI; the first reply tells which one to use from now on. */
  from?: string;
  xml?: string;
  date?: string;
}): string {
  const base = o.fileName.replace(/\.xml$/i, "");
  const from = o.from ?? SDI_ADDRESS;
  const xml = o.xml ?? { RC: rcXml, NS: nsXml, MC: mcXml }[o.type](o.fileName);
  const inner = mime(
    [
      `Message-ID: <sdi-${o.id}>`,
      `From: ${from}`,
      `To: ${OWNER_PEC}`,
      `Subject: ${o.type}: ${o.fileName}`,
    ],
    [{ name: `${base}_${o.type}_001.xml`, content: xml }],
  );
  const subject = { RC: "CONSEGNA", NS: "NOTIFICA DI SCARTO", MC: "MANCATA CONSEGNA" }[o.type];
  return pecEnvelope({
    tipo: "posta-certificata",
    messageId: o.id,
    subject: `POSTA CERTIFICATA: ${subject}: ${o.fileName}`,
    from,
    date: o.date,
    inner,
  });
}

/** A supplier invoice delivered by the SdI: the invoice file plus its metadata file. */
export function receivedInvoiceMessage(o: {
  id: string;
  fileName?: string;
  /** Invoice content; `.p7m` names carry it base64-wrapped like a signed file would. */
  content?: string;
  date?: string;
  padding?: number;
}): string {
  const fileName = o.fileName ?? "IT09876543211_00007.xml";
  const body = `<?xml version="1.0"?><p:FatturaElettronica versione="FPR12"><x>${"a".repeat(o.padding ?? 0)}</x></p:FatturaElettronica>`;
  const inner = mime(
    [
      `Message-ID: <inv-${o.id}>`,
      `From: ${SDI_ADDRESS}`,
      `To: ${OWNER_PEC}`,
      "Subject: Invio file",
    ],
    [
      { name: fileName, content: o.content ?? body, encoding: "base64" },
      { name: `${fileName.replace(/\.xml(\.p7m)?$/i, "")}_MT_001.xml`, content: "<MT/>" },
    ],
  );
  return pecEnvelope({
    tipo: "posta-certificata",
    messageId: o.id,
    subject: "POSTA CERTIFICATA: Invio file",
    from: SDI_ADDRESS,
    date: o.date,
    inner,
  });
}

/** Mail that is not about e-invoicing: a plain message, and a PEC message from someone else. */
export function plainMail(id: string): string {
  return crlf([
    `Message-ID: <${id}>`,
    "From: newsletter@example.com",
    `To: ${OWNER_PEC}`,
    "Subject: Hello",
    "Date: Mon, 02 Nov 2026 09:20:00 +0100",
    "",
    "Just a message.",
    "",
  ]);
}

export function otherPecMail(id: string): string {
  const inner = mime(
    [
      `Message-ID: <o-${id}>`,
      "From: comune@pec.example.it",
      `To: ${OWNER_PEC}`,
      "Subject: Comunicazione",
    ],
    [{ name: "avviso.xml", content: "<avviso/>" }],
  );
  return pecEnvelope({
    tipo: "posta-certificata",
    messageId: id,
    subject: "POSTA CERTIFICATA: Comunicazione",
    from: "comune@pec.example.it",
    inner,
  });
}
