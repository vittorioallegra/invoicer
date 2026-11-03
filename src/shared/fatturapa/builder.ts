import { XMLBuilder } from "fast-xml-parser";
import type { ClientData } from "../client";
import { type InvoiceBody, invoiceTotalsInput } from "../invoice";
import { termsReferenceDate } from "../payment-terms";
import type { ProfileData } from "../profile";
import { computeTotals, type Natura, type Totals } from "../totals";
import { encodeFileProgressive, fatturaFileName } from "./file-name";
import { formatBasisPoints, formatCents, formatQuantity, formatUnitPrice } from "./numbers";
import { CAUSALE_MAX, chunkText, naturaFullText, naturaReference, toLatin } from "./text";

export const FATTURAPA_NAMESPACE = "http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2";
export const FATTURAPA_FORMAT = "FPR12";

export type FatturaBuildErrorCode = "totals_incomplete";

export class FatturaBuildError extends Error {
  constructor(readonly code: FatturaBuildErrorCode) {
    super(code);
    this.name = "FatturaBuildError";
  }
}

export type FatturaIssuer = Pick<
  ProfileData,
  | "name"
  | "vatNumber"
  | "taxCode"
  | "address"
  | "postalCode"
  | "city"
  | "province"
  | "country"
  | "regimeFiscale"
>;

export type FatturaClient = Pick<
  ClientData,
  | "type"
  | "name"
  | "vatNumber"
  | "taxCode"
  | "foreignTaxId"
  | "countryCode"
  | "address"
  | "postalCode"
  | "city"
  | "province"
  | "recipientCode"
  | "pec"
>;

export type FatturaInvoice = Pick<
  InvoiceBody,
  "documentType" | "currency" | "operationDate" | "dueDate" | "lines" | "data"
>;

export interface FatturaInput {
  issuer: FatturaIssuer;
  client: FatturaClient;
  invoice: FatturaInvoice;
  /** Invoice number as printed, and its issue date (`YYYY-MM-DD`). */
  number: string;
  issueDate: string;
  /** Counter value of this transmission attempt (`transmissions.file_progressive`). */
  fileProgressive: number;
  /** TD04 only: the corrected invoice (DatiFattureCollegate). */
  linked?: { number: string; issueDate: string } | null;
}

export interface FatturaResult {
  xml: string;
  /** `IT<idCodice>_<progressive>.xml`, equal to the `ProgressivoInvio` in the header. */
  fileName: string;
  /** Totals in the invoice currency, as written in the XML. */
  totals: Totals;
}

type Node = Record<string, unknown>;

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  indentBy: "  ",
  suppressEmptyNode: false,
});

/** Drops undefined values so optional elements are simply absent. */
function node(fields: Record<string, unknown>): Node {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

const groupKeyOf = (line: { vatRateBp: number | null; natura: Natura | null }) =>
  line.natura !== null ? `natura:${line.natura}` : `vat:${line.vatRateBp}`;

/** Totals of the invoice, in its own currency. */
function planTotals(invoice: FatturaInvoice): Totals {
  try {
    return computeTotals(invoiceTotalsInput(invoice));
  } catch {
    throw new FatturaBuildError("totals_incomplete");
  }
}

function buildParty(
  party: { name: string; vatNumber: string | null; taxCode: string | null },
  idCodice: { country: string; code: string } | null,
) {
  return node({
    IdFiscaleIVA: idCodice ? { IdPaese: idCodice.country, IdCodice: idCodice.code } : undefined,
    CodiceFiscale: party.taxCode ?? undefined,
    Anagrafica: { Denominazione: toLatin(party.name, 80) },
  });
}

function clientIdentity(client: FatturaClient) {
  const country = client.countryCode;
  if (client.type === "it_company") {
    return buildParty(client, { country: "IT", code: client.vatNumber ?? "" });
  }
  if (client.type === "it_private") return buildParty(client, null);
  const rawId = (client.foreignTaxId ?? "").replaceAll(/\s+/g, "");
  const code =
    client.type === "eu_company" && rawId.startsWith(country) ? rawId.slice(country.length) : rawId;
  // Non-EU clients without a tax identifier use the AdE convention 0000000.
  return buildParty(client, { country, code: (code || "0000000").slice(0, 28) });
}

function clientSede(client: FatturaClient) {
  const italian = client.type === "it_company" || client.type === "it_private";
  return node({
    Indirizzo: toLatin(client.address, 60),
    // The XSD wants five digits; the AdE convention for foreign addresses is 00000.
    CAP: italian ? client.postalCode : "00000",
    Comune: toLatin(client.city, 60),
    Provincia: italian ? (client.province ?? undefined) : undefined,
    Nazione: client.countryCode,
  });
}

/** Builds the FatturaPA (FPR12) XML for one transmission attempt of an invoice. */
export function buildFatturaXml(input: FatturaInput): FatturaResult {
  const { issuer, client, invoice, linked } = input;
  const totals = planTotals(invoice);
  const data = invoice.data;
  const progressive = encodeFileProgressive(input.fileProgressive);
  const fileName = fatturaFileName(issuer.country, issuer.vatNumber, input.fileProgressive);
  const ritenutaOn = invoice.data.ritenuta !== null;
  const cassa = invoice.data.cassa;

  // Lines grouped like the totals engine does, for the cassa blocks and the VAT summary.
  const lineBases = new Map<string, number>();
  invoice.lines.forEach((line, index) => {
    const key = groupKeyOf(line);
    lineBases.set(key, (lineBases.get(key) ?? 0) + (totals.lines[index]?.baseCents ?? 0));
  });

  const lines = invoice.lines.map((line, index) => {
    const planned = totals.lines[index];
    const exactUnitPrice = cassa?.mode !== "included";
    return node({
      NumeroLinea: String(index + 1),
      Descrizione: toLatin(line.description, 1000),
      Quantita: formatQuantity(line.quantityMilli),
      UnitaMisura: line.unit ? toLatin(line.unit, 10) : undefined,
      PrezzoUnitario: exactUnitPrice
        ? formatCents(line.unitPriceCents)
        : formatUnitPrice(planned?.baseCents ?? 0, line.quantityMilli),
      PrezzoTotale: formatCents(planned?.baseCents ?? 0),
      AliquotaIVA: formatBasisPoints(line.natura === null ? (line.vatRateBp ?? 0) : 0),
      Ritenuta: ritenutaOn ? "SI" : undefined,
      Natura: line.natura ?? undefined,
    });
  });

  const naturaTexts = new Map<Natura, string>();
  for (const line of invoice.lines) {
    if (line.natura !== null && !naturaTexts.has(line.natura)) {
      naturaTexts.set(line.natura, naturaFullText(line.natura, data.naturaTexts));
    }
  }

  const summary = totals.groups.map((group) => {
    const text = group.natura ? naturaTexts.get(group.natura) : undefined;
    return node({
      AliquotaIVA: formatBasisPoints(group.vatRateBp ?? 0),
      Natura: group.natura ?? undefined,
      ImponibileImporto: formatCents(group.taxableCents),
      Imposta: formatCents(group.vatCents),
      EsigibilitaIVA: "I",
      RiferimentoNormativo: text ? naturaReference(text) : undefined,
    });
  });

  const cassaBlocks = cassa
    ? totals.groups.flatMap((group) => {
        const base = lineBases.get(group.key) ?? 0;
        const contribution = group.taxableCents - base;
        if (contribution <= 0) return [];
        return [
          node({
            TipoCassa: cassa.type === "rivalsa_inps" ? "TC22" : cassa.type,
            AlCassa: formatBasisPoints(cassa.rateBp),
            ImportoContributoCassa: formatCents(contribution),
            ImponibileCassa: formatCents(base),
            AliquotaIVA: formatBasisPoints(group.vatRateBp ?? 0),
            Ritenuta: ritenutaOn && cassa.subjectToRitenuta ? "SI" : undefined,
            Natura: group.natura ?? undefined,
          }),
        ];
      })
    : [];

  // Causale: the complete natura texts that do not fit RiferimentoNormativo.
  const causali: string[] = [];
  for (const text of naturaTexts.values()) {
    if (naturaReference(text) !== text) causali.push(...chunkText(text, CAUSALE_MAX));
  }

  const payment = data.payment;
  // Reference date + days must equal the due date, which only holds for invoice-date terms; an
  // end-of-month due date is written on its own.
  const terms =
    payment.terms && !payment.dueDateCustom && payment.terms.basis === "invoice_date"
      ? payment.terms
      : null;
  const datiPagamento = payment.method
    ? node({
        CondizioniPagamento: "TP02",
        DettaglioPagamento: node({
          Beneficiario: payment.accountHolder ? toLatin(payment.accountHolder, 200) : undefined,
          ModalitaPagamento: payment.method,
          // The terms are described only when the due date comes from them; a hand-set date
          // stands alone. Order follows the XSD sequence.
          DataRiferimentoTerminiPagamento: terms
            ? termsReferenceDate(input.issueDate, terms)
            : undefined,
          GiorniTerminiPagamento: terms ? String(terms.days) : undefined,
          DataScadenzaPagamento: invoice.dueDate ?? undefined,
          ImportoPagamento: formatCents(totals.amountDueCents),
          IstitutoFinanziario: payment.bankName ? toLatin(payment.bankName, 80) : undefined,
          IBAN: payment.iban ?? undefined,
          BIC: payment.bic ?? undefined,
        }),
      })
    : undefined;

  const foreignRecipient = client.type === "eu_company" || client.type === "non_eu_company";
  const body = node({
    DatiGenerali: node({
      DatiGeneraliDocumento: node({
        TipoDocumento: invoice.documentType,
        Divisa: invoice.currency,
        Data: input.issueDate,
        Numero: toLatin(input.number, 20),
        DatiRitenuta: data.ritenuta
          ? node({
              TipoRitenuta: data.ritenuta.type,
              ImportoRitenuta: formatCents(totals.ritenutaCents),
              AliquotaRitenuta: formatBasisPoints(data.ritenuta.rateBp),
              CausalePagamento: data.ritenuta.causale,
            })
          : undefined,
        DatiBollo:
          totals.stampCents > 0
            ? { BolloVirtuale: "SI", ImportoBollo: formatCents(totals.stampCents) }
            : undefined,
        DatiCassaPrevidenziale: cassaBlocks.length > 0 ? cassaBlocks : undefined,
        ImportoTotaleDocumento: formatCents(totals.documentTotalCents),
        Causale: causali.length > 0 ? causali : undefined,
      }),
      DatiFattureCollegate:
        invoice.documentType === "TD04" && linked
          ? { IdDocumento: toLatin(linked.number, 20), Data: linked.issueDate }
          : undefined,
    }),
    DatiBeniServizi: { DettaglioLinee: lines, DatiRiepilogo: summary },
    DatiPagamento: datiPagamento,
  });

  const document = {
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    "p:FatturaElettronica": {
      "@_versione": FATTURAPA_FORMAT,
      "@_xmlns:ds": "http://www.w3.org/2000/09/xmldsig#",
      "@_xmlns:p": FATTURAPA_NAMESPACE,
      "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@_xsi:schemaLocation": `${FATTURAPA_NAMESPACE} http://www.fatturapa.gov.it/export/fatturazione/sdi/fatturapa/v1.2/Schema_del_file_xml_FatturaPA_versione_1.2.xsd`,
      FatturaElettronicaHeader: {
        DatiTrasmissione: node({
          IdTrasmittente: { IdPaese: issuer.country, IdCodice: issuer.vatNumber },
          ProgressivoInvio: progressive,
          FormatoTrasmissione: FATTURAPA_FORMAT,
          CodiceDestinatario: foreignRecipient ? "XXXXXXX" : client.recipientCode,
          PECDestinatario:
            client.recipientCode === "0000000" && client.pec ? client.pec : undefined,
        }),
        CedentePrestatore: {
          DatiAnagrafici: {
            ...buildParty(issuer, { country: issuer.country, code: issuer.vatNumber }),
            RegimeFiscale: issuer.regimeFiscale,
          },
          Sede: node({
            Indirizzo: toLatin(issuer.address, 60),
            CAP: issuer.postalCode,
            Comune: toLatin(issuer.city, 60),
            Provincia: issuer.province ?? undefined,
            Nazione: issuer.country,
          }),
        },
        CessionarioCommittente: {
          DatiAnagrafici: clientIdentity(client),
          Sede: clientSede(client),
        },
      },
      FatturaElettronicaBody: body,
    },
  };

  return { xml: `${xmlBuilder.build(document)}\n`, fileName, totals };
}
