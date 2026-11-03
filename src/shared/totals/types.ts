/** Natura codes for lines without VAT (FatturaPA `Natura`). */
export const NATURA_CODES = [
  "N1",
  "N2.1",
  "N2.2",
  "N3.1",
  "N3.2",
  "N3.3",
  "N3.4",
  "N3.5",
  "N3.6",
  "N4",
  "N5",
  "N6.1",
  "N6.2",
  "N6.3",
  "N6.4",
  "N6.5",
  "N6.6",
  "N6.7",
  "N6.8",
  "N6.9",
  "N7",
] as const;
export type Natura = (typeof NATURA_CODES)[number];

export const DOCUMENT_TYPES = ["TD01", "TD04"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Cassa previdenziale codes (FatturaPA `TipoCassa`). */
export const CASSA_TYPE_CODES = [
  "TC01",
  "TC02",
  "TC03",
  "TC04",
  "TC05",
  "TC06",
  "TC07",
  "TC08",
  "TC09",
  "TC10",
  "TC11",
  "TC12",
  "TC13",
  "TC14",
  "TC15",
  "TC16",
  "TC17",
  "TC18",
  "TC19",
  "TC20",
  "TC21",
  "TC22",
] as const;
export type CassaTypeCode = (typeof CASSA_TYPE_CODES)[number];

/** Rivalsa INPS (gestione separata) is modelled apart from the TC codes; the XML builder (step 10) emits rivalsa_inps as TipoCassa TC22. */
export type CassaType = "rivalsa_inps" | CassaTypeCode;

/** `excluded`: amounts exclude the contribution; `included`: amounts are "cassa inclusa". */
export type CassaMode = "excluded" | "included";

/**
 * Ritenuta payment causes (FatturaPA `CausalePagamento`, the CU codes): the `CausalePagamentoType`
 * enumeration of the vendored XSD without Z, which is no longer valid from 2021 (ZO replaces it).
 */
export const CAUSALE_PAGAMENTO_CODES = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "G",
  "H",
  "I",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "L1",
  "M1",
  "M2",
  "O1",
  "V1",
  "ZO",
] as const;
export type CausalePagamento = (typeof CAUSALE_PAGAMENTO_CODES)[number];

export interface TotalsLine {
  description: string;
  /** Quantity in thousandths (1000 = 1). */
  quantityMilli: number;
  /** Unit price in cents of the document currency. */
  unitPriceCents: number;
  /** VAT rate in basis points (2200 = 22%); null when the line has a natura. */
  vatRateBp: number | null;
  /** Natura code for lines without VAT; null when the line has a VAT rate. */
  natura: Natura | null;
}

export interface CassaInput {
  type: CassaType;
  /** Contribution rate in basis points (400 = 4%). */
  rateBp: number;
  mode: CassaMode;
  /** Whether the contribution is part of the ritenuta base (see `defaultCassaSubjectToRitenuta`). */
  subjectToRitenuta: boolean;
}

export interface RitenutaInput {
  /** FatturaPA `TipoRitenuta`, e.g. RT01 (natural persons). Metadata for the XML. */
  type: string;
  /** Rate in basis points (2000 = 20%). */
  rateBp: number;
  /**
   * Share of the amount subject to ritenuta the rate applies to, in basis points (10000 = 100%,
   * the default; 1000 = 10%). FatturaPA has no element for it: the XML carries only the rate and
   * the resulting amount.
   */
  baseBp?: number;
  /** FatturaPA `CausalePagamento`, e.g. A. Metadata for the XML. */
  causale: CausalePagamento;
}

export interface TotalsInput {
  documentType: DocumentType;
  currency: string;
  lines: readonly TotalsLine[];
  cassa?: CassaInput | null;
  ritenuta?: RitenutaInput | null;
  /** Whether the virtual stamp (bollo) is applied; see `bolloSuggested` in the result. */
  bollo: boolean;
}

export interface LineTotals {
  /** quantity x unit price, rounded to the cent (the typed amount in `included` mode). */
  amountCents: number;
  /** Taxable base of the line (equal to the amount in `excluded` mode). */
  baseCents: number;
  /** Contribution carried by the line (`included` mode only, otherwise 0). */
  contributionCents: number;
}

export interface VatGroup {
  /** Grouping key: `vat:<bp>` or `natura:<code>`. */
  key: string;
  vatRateBp: number | null;
  natura: Natura | null;
  /** Taxable amount of the group, including the contribution that takes the group's rate. */
  taxableCents: number;
  vatCents: number;
}

export interface Totals {
  currency: string;
  documentType: DocumentType;
  /** +1 for TD01, -1 for TD04: amounts stay positive, the document type gives the sign. */
  sign: 1 | -1;
  lines: LineTotals[];
  groups: VatGroup[];
  /** Total cassa/rivalsa contribution (already inside the group taxable amounts). */
  contributionCents: number;
  /** Sum of the group taxable amounts (lines base + contribution). */
  taxableCents: number;
  vatCents: number;
  /** Amount the ritenuta rate applies to: the base share of the amount subject to ritenuta. */
  ritenutaBaseCents: number;
  ritenutaCents: number;
  stampCents: number;
  /** Taxable + VAT + stamp (FatturaPA `ImportoTotaleDocumento`); ritenuta is not deducted. */
  documentTotalCents: number;
  /** Document total minus ritenuta. */
  amountDueCents: number;
  /** `amountDueCents` with the document sign applied (negative for a credit note). */
  signedAmountDueCents: number;
  /** Sum of the amounts of the lines with a natura. */
  naturaAmountCents: number;
  /** True when `naturaAmountCents` exceeds 77.47 EUR (bollo virtuale suggested). */
  bolloSuggested: boolean;
}
