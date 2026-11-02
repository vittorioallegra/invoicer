import type { CassaInput, DocumentType, RitenutaInput, TotalsLine } from "../totals/types";

/**
 * Invoice fixtures (a)-(g) of spec AC 6, shared by the totals tests and, later, the XML (step 10)
 * and PDF (step 11) tests. Issuer and client data are illustrative placeholders. Expected values
 * are literal numbers worked out by hand from the rules in the spec (the table after AC 6),
 * never computed by the engine. All amounts are integer cents of the document currency.
 */
export interface FixtureClient {
  type: "it_company" | "it_private" | "eu_company" | "non_eu_company";
  name: string;
  country: string;
  vatId?: string;
  taxCode?: string;
  /** SdI recipient code. */
  codiceDestinatario: string;
  pdfLanguage: "it" | "en";
}

export interface FixtureExpected {
  /** Cassa/rivalsa contribution. */
  contributionCents: number;
  /** Sum of the group taxable amounts (lines + contribution). */
  taxableCents: number;
  vatCents: number;
  ritenutaCents: number;
  stampCents: number;
  /** Taxable + VAT + stamp. */
  documentTotalCents: number;
  amountDueCents: number;
  /** Per line: typed amount, base and contribution. */
  lines: { amountCents: number; baseCents: number; contributionCents: number }[];
}

export interface InvoiceFixture {
  id: string;
  title: string;
  issuer: { regime: "RF01" | "RF19" };
  client: FixtureClient;
  documentType: DocumentType;
  currency: string;
  lines: TotalsLine[];
  cassa?: CassaInput;
  ritenuta?: RitenutaInput;
  bollo: boolean;
  /** Natura legal text expected on the document, when lines carry a natura. */
  naturaText?: string;
  /** TD04 only: the linked invoice (DatiFattureCollegate). */
  linkedInvoice?: { fixtureId: string; number: string; date: string };
  expected: FixtureExpected;
}

const line = (
  description: string,
  quantityMilli: number,
  unitPriceCents: number,
  tax: { vatRateBp: number } | { natura: NonNullable<TotalsLine["natura"]> },
): TotalsLine => ({
  description,
  quantityMilli,
  unitPriceCents,
  vatRateBp: "vatRateBp" in tax ? tax.vatRateBp : null,
  natura: "natura" in tax ? tax.natura : null,
});

const itCompany: FixtureClient = {
  type: "it_company",
  name: "Acme Srl",
  country: "IT",
  vatId: "01234567897",
  codiceDestinatario: "0000000",
  pdfLanguage: "it",
};

const RITENUTA_20: RitenutaInput = { type: "RT01", rateBp: 2000, causale: "A" };

/** (a) RF01, Italian company, 22% VAT, ritenuta 20% and rivalsa INPS 4% (excluded). */
const a: InvoiceFixture = {
  id: "a",
  title: "RF01 Italian company, 22% VAT, ritenuta 20%, rivalsa INPS 4%",
  issuer: { regime: "RF01" },
  client: itCompany,
  documentType: "TD01",
  currency: "EUR",
  lines: [
    line("Consulting", 1000, 120000, { vatRateBp: 2200 }),
    line("Analysis (hours)", 7500, 6530, { vatRateBp: 2200 }),
  ],
  cassa: { type: "rivalsa_inps", rateBp: 400, mode: "excluded", subjectToRitenuta: true },
  ritenuta: RITENUTA_20,
  bollo: false,
  expected: {
    contributionCents: 6759,
    taxableCents: 175734,
    vatCents: 38661,
    ritenutaCents: 35147,
    stampCents: 0,
    documentTotalCents: 214395,
    amountDueCents: 179248,
    lines: [
      { amountCents: 120000, baseCents: 120000, contributionCents: 0 },
      { amountCents: 48975, baseCents: 48975, contributionCents: 0 },
    ],
  },
};

/** (b) RF19 forfettario, Italian private person, N2.2 with legal text, bollo 2.00. */
const b: InvoiceFixture = {
  id: "b",
  title: "RF19 forfettario, Italian private person, N2.2, bollo",
  issuer: { regime: "RF19" },
  client: {
    type: "it_private",
    name: "Mario Rossi",
    country: "IT",
    taxCode: "RSSMRA80A01H501U",
    codiceDestinatario: "0000000",
    pdfLanguage: "it",
  },
  documentType: "TD01",
  currency: "EUR",
  lines: [
    line("Consulting", 1000, 80000, { natura: "N2.2" }),
    line("Report copies", 3000, 4170, { natura: "N2.2" }),
  ],
  bollo: true,
  naturaText: "Operazione effettuata ai sensi dell'art. 1, commi 54-89, L. 190/2014",
  expected: {
    contributionCents: 0,
    taxableCents: 92510,
    vatCents: 0,
    ritenutaCents: 0,
    stampCents: 200,
    documentTotalCents: 92710,
    amountDueCents: 92710,
    lines: [
      { amountCents: 80000, baseCents: 80000, contributionCents: 0 },
      { amountCents: 12510, baseCents: 12510, contributionCents: 0 },
    ],
  },
};

/** (c) EU company, services under art. 7-ter DPR 633/72 (N2.1), codice destinatario XXXXXXX. */
const c: InvoiceFixture = {
  id: "c",
  title: "EU company, N2.1 (art. 7-ter), XXXXXXX",
  issuer: { regime: "RF01" },
  client: {
    type: "eu_company",
    name: "Beispiel GmbH",
    country: "DE",
    vatId: "DE123456789",
    codiceDestinatario: "XXXXXXX",
    pdfLanguage: "en",
  },
  documentType: "TD01",
  currency: "EUR",
  lines: [
    line("Software consulting (hours)", 12500, 8730, { natura: "N2.1" }),
    line("Fixed fee: documentation", 1000, 25000, { natura: "N2.1" }),
  ],
  bollo: true,
  naturaText: "Operazione non soggetta a IVA ai sensi dell'art. 7-ter del DPR 633/72",
  expected: {
    contributionCents: 0,
    taxableCents: 134125,
    vatCents: 0,
    ritenutaCents: 0,
    stampCents: 200,
    documentTotalCents: 134325,
    amountDueCents: 134325,
    lines: [
      { amountCents: 109125, baseCents: 109125, contributionCents: 0 },
      { amountCents: 25000, baseCents: 25000, contributionCents: 0 },
    ],
  },
};

/**
 * (d) Non-EU company, N2.1, currency USD. Totals are in USD; the stamp is not applied here
 * because it is a EUR amount (the XML keeps the original currency).
 */
const d: InvoiceFixture = {
  id: "d",
  title: "Non-EU company, N2.1, USD",
  issuer: { regime: "RF01" },
  client: {
    type: "non_eu_company",
    name: "Example Inc.",
    country: "US",
    vatId: "123456789",
    codiceDestinatario: "XXXXXXX",
    pdfLanguage: "en",
  },
  documentType: "TD01",
  currency: "USD",
  lines: [
    line("Annual retainer", 1000, 250000, { natura: "N2.1" }),
    line("Workshops", 3000, 47999, { natura: "N2.1" }),
  ],
  bollo: false,
  naturaText: "Operazione non soggetta a IVA ai sensi dell'art. 7-ter del DPR 633/72",
  expected: {
    contributionCents: 0,
    taxableCents: 393997,
    vatCents: 0,
    ritenutaCents: 0,
    stampCents: 0,
    documentTotalCents: 393997,
    amountDueCents: 393997,
    lines: [
      { amountCents: 250000, baseCents: 250000, contributionCents: 0 },
      { amountCents: 143997, baseCents: 143997, contributionCents: 0 },
    ],
  },
};

/**
 * (e) Cassa TC04 (Inarcassa, engineers and architects), contributo integrativo 4%, 22% VAT
 * on the contribution; ritenuta 20% on the fees only (the contribution is not subject to it).
 */
const e: InvoiceFixture = {
  id: "e",
  title: "Cassa TC04 4% with VAT on the contribution",
  issuer: { regime: "RF01" },
  client: itCompany,
  documentType: "TD01",
  currency: "EUR",
  lines: [
    line("Structural design", 1000, 320000, { vatRateBp: 2200 }),
    line("Site supervision (hours)", 18500, 7130, { vatRateBp: 2200 }),
  ],
  cassa: { type: "TC04", rateBp: 400, mode: "excluded", subjectToRitenuta: false },
  ritenuta: RITENUTA_20,
  bollo: false,
  expected: {
    contributionCents: 18076,
    taxableCents: 469981,
    vatCents: 103396,
    ritenutaCents: 90381,
    stampCents: 0,
    documentTotalCents: 573377,
    amountDueCents: 482996,
    lines: [
      { amountCents: 320000, baseCents: 320000, contributionCents: 0 },
      { amountCents: 131905, baseCents: 131905, contributionCents: 0 },
    ],
  },
};

const rivalsaIncluded = (typedCents: number): Pick<InvoiceFixture, "lines" | "cassa"> => ({
  lines: [line("Consulting, cassa inclusa", 1000, typedCents, { vatRateBp: 2200 })],
  cassa: { type: "rivalsa_inps", rateBp: 400, mode: "included", subjectToRitenuta: true },
});

/** (f) Rivalsa INPS 4% in `included` mode, typed amount 1,040.00 -> base 1,000.00 + 40.00. */
const f1: InvoiceFixture = {
  id: "f1",
  title: "Rivalsa INPS 4% included, typed 1,040.00",
  issuer: { regime: "RF01" },
  client: itCompany,
  documentType: "TD01",
  currency: "EUR",
  ...rivalsaIncluded(104000),
  bollo: false,
  expected: {
    contributionCents: 4000,
    taxableCents: 104000,
    vatCents: 22880,
    ritenutaCents: 0,
    stampCents: 0,
    documentTotalCents: 126880,
    amountDueCents: 126880,
    lines: [{ amountCents: 104000, baseCents: 100000, contributionCents: 4000 }],
  },
};

/** (f) Typed amount 999.99 -> base 961.53 + contribution 38.46, summing to 999.99 exactly. */
const f2: InvoiceFixture = {
  id: "f2",
  title: "Rivalsa INPS 4% included, typed 999.99",
  issuer: { regime: "RF01" },
  client: itCompany,
  documentType: "TD01",
  currency: "EUR",
  ...rivalsaIncluded(99999),
  bollo: false,
  expected: {
    contributionCents: 3846,
    taxableCents: 99999,
    vatCents: 22000,
    ritenutaCents: 0,
    stampCents: 0,
    documentTotalCents: 121999,
    amountDueCents: 121999,
    lines: [{ amountCents: 99999, baseCents: 96153, contributionCents: 3846 }],
  },
};

/** (g) TD04 partial credit note linked to (a); amounts positive, the document type signs. */
const g: InvoiceFixture = {
  id: "g",
  title: "TD04 partial credit note linked to (a)",
  issuer: { regime: "RF01" },
  client: itCompany,
  documentType: "TD04",
  currency: "EUR",
  lines: [line("Analysis (hours), partial credit", 3000, 6530, { vatRateBp: 2200 })],
  cassa: { type: "rivalsa_inps", rateBp: 400, mode: "excluded", subjectToRitenuta: true },
  ritenuta: RITENUTA_20,
  bollo: false,
  linkedInvoice: { fixtureId: "a", number: "1", date: "2026-03-15" },
  expected: {
    contributionCents: 784,
    taxableCents: 20374,
    vatCents: 4482,
    ritenutaCents: 4075,
    stampCents: 0,
    documentTotalCents: 24856,
    amountDueCents: 20781,
    lines: [{ amountCents: 19590, baseCents: 19590, contributionCents: 0 }],
  },
};

export const INVOICE_FIXTURES: readonly InvoiceFixture[] = [a, b, c, d, e, f1, f2, g];
