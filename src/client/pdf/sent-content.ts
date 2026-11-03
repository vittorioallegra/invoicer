import type { ClientRecord } from "../../shared/client";
import {
  buildFatturaXml,
  decodeFileProgressive,
  type FatturaClient,
  type FatturaInput,
  type FatturaIssuer,
  parseFatturaXml,
  type ReceivedParty,
} from "../../shared/fatturapa";
import { type InvoiceRecord, invoiceLanguage } from "../../shared/invoice";
import { phoneForXml } from "../../shared/profile";
import type { InvoicePdfInput } from "./invoice-model";

/** The stored XML does not describe the invoice as it is now (edited after the last attempt). */
export class SentContentError extends Error {
  constructor(readonly code: "unreadable_xml" | "differs") {
    super(code);
    this.name = "SentContentError";
  }
}

/** XML placeholders for a foreign party without a tax id (see the builder); not real ids. */
const FOREIGN_ID_FALLBACKS = new Set(["99999999999", "0000000"]);

function issuerFromXml(party: ReceivedParty, currentPhone: string | null): FatturaIssuer {
  // The XML holds the digits only; print the number as typed when it is still the one sent.
  const phone =
    party.phone && currentPhone && phoneForXml(currentPhone) === party.phone
      ? currentPhone
      : party.phone;
  return {
    name: party.name,
    vatNumber: party.vatId?.code ?? "",
    taxCode: party.taxCode,
    address: party.address.street,
    postalCode: party.address.postalCode,
    city: party.address.city,
    province: party.address.province,
    country: party.vatId?.country ?? party.address.country,
    email: party.email,
    phone,
    regimeFiscale: (party.regimeFiscale ?? "RF01") as FatturaIssuer["regimeFiscale"],
  };
}

/**
 * The client as the XML carries it: name, tax ids, address and routing come from the file. What
 * the XML cannot hold (the client type, a foreign postal code, the foreign recipient code) comes
 * from the client record; the caller's rebuild check catches any change that matters.
 */
function clientFromXml(
  party: ReceivedParty,
  routing: { recipientCode: string; pec: string | null },
  current: ClientRecord,
): FatturaClient {
  const italian = current.type === "it_company" || current.type === "it_private";
  const id = party.vatId;
  const foreignId = id && !FOREIGN_ID_FALLBACKS.has(id.code) ? id : null;
  return {
    type: current.type,
    name: party.name,
    vatNumber: current.type === "it_company" ? (id?.code ?? null) : null,
    taxCode: party.taxCode,
    foreignTaxId: italian
      ? null
      : foreignId
        ? current.type === "eu_company"
          ? `${foreignId.country}${foreignId.code}`
          : foreignId.code
        : null,
    countryCode: party.address.country,
    address: party.address.street,
    postalCode: italian ? party.address.postalCode : current.postalCode,
    city: party.address.city,
    province: party.address.province,
    recipientCode: italian ? routing.recipientCode : current.recipientCode,
    pec: italian ? routing.pec : current.pec,
  };
}

/**
 * The PDF input of an invoice sent as `xml`: the parties come from the stored XML (so a client or
 * company edited later does not change the document), the lines, totals, payment data and note
 * from the invoice record. The XML is then rebuilt from that input and must equal the stored file
 * byte for byte; otherwise the record no longer describes what was sent and this throws
 * `SentContentError("differs")`, so the PDF can never show something the XML does not say.
 * `currentPhone` is the company phone as typed on the profile: it is printed instead of the XML's
 * digits only while it still maps to that XML value.
 */
export function pdfInputFromSentXml(
  xml: string,
  invoice: InvoiceRecord,
  currentClient: ClientRecord,
  currentPhone: string | null = null,
): InvoicePdfInput {
  let parsed: ReturnType<typeof parseFatturaXml>;
  try {
    parsed = parseFatturaXml(xml);
  } catch {
    throw new SentContentError("unreadable_xml");
  }
  const progressive = decodeFileProgressive(parsed.transmission.progressive);
  if (progressive === null || !invoice.number || !invoice.issueDate) {
    throw new SentContentError("unreadable_xml");
  }
  const issuer = issuerFromXml(parsed.supplier, currentPhone);
  const client = clientFromXml(parsed.customer, parsed.transmission, currentClient);
  const linked =
    invoice.linked?.number && invoice.linked.issueDate
      ? { number: invoice.linked.number, issueDate: invoice.linked.issueDate }
      : null;
  const input: FatturaInput = {
    issuer,
    client,
    invoice,
    number: invoice.number,
    issueDate: invoice.issueDate,
    fileProgressive: progressive,
    linked,
  };
  let rebuilt: string;
  try {
    rebuilt = buildFatturaXml(input).xml;
  } catch {
    throw new SentContentError("differs");
  }
  if (rebuilt !== xml) throw new SentContentError("differs");
  const { fileProgressive: _progressive, ...pdfInput } = input;
  return { ...pdfInput, language: invoiceLanguage(invoice.data, currentClient) };
}
