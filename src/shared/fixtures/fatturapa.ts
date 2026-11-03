import type { FatturaClient, FatturaInput, FatturaIssuer } from "../fatturapa/builder";
import { EMPTY_INVOICE_DATA, type InvoiceData } from "../invoice";
import type { InvoiceFixture } from "./invoices";

/**
 * Issuer, client and payment data that turn an invoice fixture (a)-(g) into XML builder input
 * (step 10) and, later, PDF input (step 11). Illustrative placeholders, never real parties.
 */
export const FIXTURE_ISSUER: Omit<FatturaIssuer, "regimeFiscale"> = {
  name: "Studio Example",
  vatNumber: "12345678903",
  taxCode: "RSSMRA80A01H501U",
  address: "Via Verdi 2",
  postalCode: "00100",
  city: "Roma",
  province: "RM",
  country: "IT",
};

/** Fixture issue date and number; the TD04 fixture links to fixture (a) at its own number/date. */
export const FIXTURE_NUMBER = "2";
export const FIXTURE_ISSUE_DATE = "2026-04-20";

function fixtureClient(fixture: InvoiceFixture): FatturaClient {
  const { client } = fixture;
  const italian = client.type === "it_company" || client.type === "it_private";
  return {
    type: client.type,
    name: client.name,
    vatNumber: client.type === "it_company" ? (client.vatId ?? null) : null,
    taxCode: client.taxCode ?? null,
    foreignTaxId: italian ? null : (client.vatId ?? null),
    countryCode: client.country,
    address: italian ? "Via Roma 1" : "Hauptstrasse 5",
    postalCode: italian ? "20100" : "10115",
    city: italian ? "Milano" : "Berlin",
    province: italian ? "MI" : null,
    recipientCode: client.codiceDestinatario,
    pec: null,
  };
}

/** Builder input for a fixture; `fileProgressive` is the transmission attempt's counter value. */
export function fixtureToFatturaInput(fixture: InvoiceFixture, fileProgressive = 1): FatturaInput {
  const data: InvoiceData = {
    ...EMPTY_INVOICE_DATA,
    cassa: fixture.cassa ?? null,
    // The fixtures' ritenuta type is a plain string; the fixtures only use valid RT codes.
    ritenuta: fixture.ritenuta
      ? ({
          ...fixture.ritenuta,
          baseBp: fixture.ritenuta.baseBp ?? 10000,
        } as InvoiceData["ritenuta"])
      : null,
    bollo: fixture.bollo,
    bolloCharge: fixture.bolloCharge ?? "client",
    naturaTexts: fixture.naturaText
      ? Object.fromEntries(
          fixture.lines.flatMap((line) => (line.natura ? [[line.natura, fixture.naturaText]] : [])),
        )
      : {},
    payment: {
      method: "MP05",
      iban: "IT60X0542811101000000123456",
      bic: null,
      accountHolder: FIXTURE_ISSUER.name,
      bankName: "Example Bank",
      terms: null,
    },
  };
  return {
    issuer: { ...FIXTURE_ISSUER, regimeFiscale: fixture.issuer.regime },
    client: fixtureClient(fixture),
    invoice: {
      documentType: fixture.documentType,
      currency: fixture.currency,
      dueDate: "2026-05-20",
      lines: fixture.lines.map((line) => ({ ...line, unit: null, note: "" })),
      data,
    },
    number: FIXTURE_NUMBER,
    issueDate: FIXTURE_ISSUE_DATE,
    fileProgressive,
    linked: fixture.linkedInvoice
      ? { number: fixture.linkedInvoice.number, issueDate: fixture.linkedInvoice.date }
      : null,
  };
}
