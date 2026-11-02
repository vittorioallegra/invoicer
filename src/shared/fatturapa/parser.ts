import { XMLParser } from "fast-xml-parser";

/**
 * Reads a received FatturaPA (FPR12 for private parties, FPA12 for the public administration)
 * into a plain structure for the readable view (step 15). Everything is kept as the text found in
 * the XML (amounts included, no float conversion) and is meant to be rendered as text only.
 * Fields the view does not need (signature, transmitter contacts, DDT, ...) are skipped.
 */

export interface ReceivedParty {
  name: string;
  vatId: { country: string; code: string } | null;
  taxCode: string | null;
  regimeFiscale: string | null;
  address: {
    street: string;
    streetNumber: string | null;
    postalCode: string;
    city: string;
    province: string | null;
    country: string;
  };
}

export interface ReceivedLine {
  number: string;
  description: string;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  total: string;
  vatRate: string;
  natura: string | null;
}

export interface ReceivedVatSummary {
  vatRate: string;
  natura: string | null;
  taxable: string;
  vat: string;
  reference: string | null;
}

export interface ReceivedPayment {
  method: string;
  dueDate: string | null;
  amount: string;
  iban: string | null;
  bankName: string | null;
}

export interface ReceivedDocument {
  documentType: string;
  currency: string;
  date: string;
  number: string;
  total: string | null;
  causali: string[];
  withholding: { type: string; amount: string; rate: string | null; reason: string | null }[];
  stamp: { amount: string | null } | null;
  lines: ReceivedLine[];
  vatSummary: ReceivedVatSummary[];
  payments: ReceivedPayment[];
  /** Invoices this one refers to (credit notes). */
  linked: { number: string; date: string | null }[];
}

export interface ReceivedInvoice {
  /** `FPR12`, `FPA12` or whatever the file declares. */
  format: string;
  transmission: {
    idPaese: string;
    idCodice: string;
    progressive: string;
    recipientCode: string;
    pec: string | null;
  };
  supplier: ReceivedParty;
  customer: ReceivedParty;
  /** One invoice file may carry several documents (batches). */
  documents: ReceivedDocument[];
}

export class FatturaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatturaParseError";
  }
}

const ALWAYS_ARRAY = new Set([
  "FatturaElettronicaBody",
  "DettaglioLinee",
  "DatiRiepilogo",
  "DatiPagamento",
  "DettaglioPagamento",
  "Causale",
  "DatiRitenuta",
  "DatiFattureCollegate",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ALWAYS_ARRAY.has(name),
});

type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asTree = (value: unknown): Tree => (isTree(value) ? value : {});
const asList = (value: unknown): Tree[] => (Array.isArray(value) ? value.filter(isTree) : []);
const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const str = (value: unknown): string => text(value) ?? "";

function party(raw: unknown): ReceivedParty {
  const data = asTree(asTree(raw).DatiAnagrafici);
  const name = asTree(data.Anagrafica);
  const vat = asTree(data.IdFiscaleIVA);
  const seat = asTree(asTree(raw).Sede);
  const person = [text(name.Nome), text(name.Cognome)].filter(Boolean).join(" ");
  return {
    name: text(name.Denominazione) ?? person,
    vatId: text(vat.IdCodice) ? { country: str(vat.IdPaese), code: str(vat.IdCodice) } : null,
    taxCode: text(data.CodiceFiscale),
    regimeFiscale: text(data.RegimeFiscale),
    address: {
      street: str(seat.Indirizzo),
      streetNumber: text(seat.NumeroCivico),
      postalCode: str(seat.CAP),
      city: str(seat.Comune),
      province: text(seat.Provincia),
      country: str(seat.Nazione),
    },
  };
}

function document(raw: Tree): ReceivedDocument {
  const general = asTree(raw.DatiGenerali);
  const doc = asTree(general.DatiGeneraliDocumento);
  const goods = asTree(raw.DatiBeniServizi);
  const stamp = asTree(doc.DatiBollo);
  return {
    documentType: str(doc.TipoDocumento),
    currency: str(doc.Divisa),
    date: str(doc.Data),
    number: str(doc.Numero),
    total: text(doc.ImportoTotaleDocumento),
    causali: (Array.isArray(doc.Causale) ? doc.Causale : []).filter(
      (item): item is string => typeof item === "string",
    ),
    withholding: asList(doc.DatiRitenuta).map((item) => ({
      type: str(item.TipoRitenuta),
      amount: str(item.ImportoRitenuta),
      rate: text(item.AliquotaRitenuta),
      reason: text(item.CausalePagamento),
    })),
    stamp: text(stamp.BolloVirtuale) ? { amount: text(stamp.ImportoBollo) } : null,
    lines: asList(goods.DettaglioLinee).map((line) => ({
      number: str(line.NumeroLinea),
      description: str(line.Descrizione),
      quantity: text(line.Quantita),
      unit: text(line.UnitaMisura),
      unitPrice: text(line.PrezzoUnitario),
      total: str(line.PrezzoTotale),
      vatRate: str(line.AliquotaIVA),
      natura: text(line.Natura),
    })),
    vatSummary: asList(goods.DatiRiepilogo).map((item) => ({
      vatRate: str(item.AliquotaIVA),
      natura: text(item.Natura),
      taxable: str(item.ImponibileImporto),
      vat: str(item.Imposta),
      reference: text(item.RiferimentoNormativo),
    })),
    payments: asList(raw.DatiPagamento).flatMap((block) =>
      asList(block.DettaglioPagamento).map((payment) => ({
        method: str(payment.ModalitaPagamento),
        dueDate: text(payment.DataScadenzaPagamento),
        amount: str(payment.ImportoPagamento),
        iban: text(payment.IBAN),
        bankName: text(payment.IstitutoFinanziario),
      })),
    ),
    linked: asList(general.DatiFattureCollegate).map((item) => ({
      number: str(item.IdDocumento),
      date: text(item.Data),
    })),
  };
}

/** Parses a FatturaPA XML text; throws `FatturaParseError` when it is not a FatturaPA. */
export function parseFatturaXml(xml: string): ReceivedInvoice {
  let tree: Tree;
  try {
    tree = asTree(parser.parse(xml.replace(/^﻿/, "")));
  } catch {
    throw new FatturaParseError("not_xml");
  }
  const root = asTree(tree.FatturaElettronica);
  const header = asTree(root.FatturaElettronicaHeader);
  if (!isTree(tree.FatturaElettronica) || Object.keys(header).length === 0) {
    throw new FatturaParseError("not_fatturapa");
  }
  const transmission = asTree(header.DatiTrasmissione);
  const sender = asTree(transmission.IdTrasmittente);
  const bodies = asList(root.FatturaElettronicaBody);
  if (bodies.length === 0) throw new FatturaParseError("not_fatturapa");
  return {
    format: str(transmission.FormatoTrasmissione) || str(root["@_versione"]),
    transmission: {
      idPaese: str(sender.IdPaese),
      idCodice: str(sender.IdCodice),
      progressive: str(transmission.ProgressivoInvio),
      recipientCode: str(transmission.CodiceDestinatario),
      pec: text(transmission.PECDestinatario),
    },
    supplier: party(header.CedentePrestatore),
    customer: party(header.CessionarioCommittente),
    documents: bodies.map(document),
  };
}
