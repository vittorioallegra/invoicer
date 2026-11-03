import type { TFunction } from "i18next";
import type { FatturaClient, FatturaInput, FatturaIssuer } from "../../shared/fatturapa";
import { FatturaBuildError, naturaFullText } from "../../shared/fatturapa";
import { formatDate, formatMoney, type UiLocale } from "../../shared/format";
import { safeTotals } from "../../shared/invoice";
import { cassaTypeLabel, type Natura, type Totals } from "../../shared/totals";

/** Everything the PDF prints; the same data the XML builder takes, plus the PDF language. */
export type InvoicePdfInput = Omit<FatturaInput, "fileProgressive"> & { language: UiLocale };

export interface PdfRow {
  label: string;
  value: string;
}

export interface PdfLine {
  description: string;
  /** Optional note printed under the description in smaller muted text. */
  note: string | null;
  quantity: string;
  unitPrice: string;
  vat: string;
  amount: string;
}

export interface PdfVatGroup {
  taxable: string;
  rate: string;
  vat: string;
}

export interface InvoicePdfModel {
  language: UiLocale;
  title: string;
  numberLine: string;
  issuerName: string;
  issuerLines: string[];
  clientName: string;
  clientLines: string[];
  meta: PdfRow[];
  linked: string | null;
  lines: PdfLine[];
  groups: PdfVatGroup[];
  naturaTexts: { code: Natura; text: string }[];
  /** The invoice note, one entry per line; empty when there is none. */
  noteLines: string[];
  /** Cassa, VAT, stamp, document total, withholding and amount due, in print order. */
  totals: (PdfRow & { strong?: boolean })[];
  ritenuta: string | null;
  payment: PdfRow[];
  legalNote: string;
}

function addressLines(a: {
  address: string | null;
  postalCode: string | null;
  city: string | null;
  province: string | null;
  country?: string | null;
  countryCode?: string | null;
}): string[] {
  const place = [a.postalCode, a.city, a.province ? `(${a.province})` : null]
    .filter(Boolean)
    .join(" ");
  return [a.address, place, a.country ?? a.countryCode].filter((part): part is string =>
    Boolean(part),
  );
}

function issuerLines(issuer: FatturaIssuer, t: TFunction): string[] {
  return [
    ...addressLines(issuer),
    t("pdf.vatNumber", { value: `${issuer.country}${issuer.vatNumber}` }),
    ...(issuer.taxCode ? [t("pdf.taxCode", { value: issuer.taxCode })] : []),
    t("pdf.regime", { code: issuer.regimeFiscale }),
  ];
}

function clientLines(client: FatturaClient, t: TFunction): string[] {
  return [
    ...addressLines(client),
    ...(client.vatNumber
      ? [t("pdf.vatNumber", { value: `${client.countryCode}${client.vatNumber}` })]
      : []),
    ...(client.foreignTaxId ? [t("pdf.foreignTaxId", { value: client.foreignTaxId })] : []),
    ...(client.taxCode ? [t("pdf.taxCode", { value: client.taxCode })] : []),
    ...(client.recipientCode ? [t("pdf.recipientCode", { value: client.recipientCode })] : []),
    ...(client.pec ? [t("pdf.pec", { value: client.pec })] : []),
  ];
}

/**
 * Turns invoice data into the strings the PDF prints, formatted for its language. Natura legal
 * texts always print in full (Italian constants or the owner's edited text), in both languages.
 */
export function buildInvoicePdfModel(input: InvoicePdfInput, t: TFunction): InvoicePdfModel {
  const { issuer, client, invoice, language } = input;
  const totals: Totals | null = safeTotals(invoice);
  if (!totals) throw new FatturaBuildError("totals_incomplete");

  const currency = invoice.currency;
  const money = (cents: number) => formatMoney(cents, language, currency);
  const number = new Intl.NumberFormat(language === "it" ? "it-IT" : "en-IE", {
    maximumFractionDigits: 3,
    useGrouping: "always",
  });
  const { data } = invoice;
  const credit = invoice.documentType === "TD04";

  const lines = invoice.lines.map((line, index) => ({
    description: line.description,
    note: line.note.trim() || null,
    quantity: [number.format(line.quantityMilli / 1000), line.unit].filter(Boolean).join(" "),
    unitPrice: money(line.unitPriceCents),
    vat:
      line.natura !== null
        ? t("pdf.exempt", { code: line.natura })
        : t("pdf.vatRate", { rate: number.format((line.vatRateBp ?? 0) / 100) }),
    amount: money(totals.lines[index]?.amountCents ?? 0),
  }));

  const groups = totals.groups.map((group) => ({
    taxable: money(group.taxableCents),
    rate:
      group.natura !== null
        ? t("pdf.exempt", { code: group.natura })
        : t("pdf.vatRate", { rate: number.format((group.vatRateBp ?? 0) / 100) }),
    vat: money(group.vatCents),
  }));

  const naturaCodes = [
    ...new Set(invoice.lines.flatMap((line) => (line.natura ? [line.natura] : []))),
  ];
  const naturaTexts = naturaCodes.map((code) => ({
    code,
    text: naturaFullText(code, data.naturaTexts),
  }));

  const rows: (PdfRow & { strong?: boolean })[] = [];
  const cassa = data.cassa;
  if (cassa && totals.contributionCents > 0) {
    const label =
      cassa.type === "rivalsa_inps"
        ? t("pdf.cassa.rivalsa_inps")
        : t("pdf.cassa.other", { label: cassaTypeLabel(cassa.type, language) });
    const contribution = t("pdf.cassa.line", {
      label,
      rate: number.format(totals.contributionRateBp / 100),
    });
    if (cassa.mode === "included") {
      // Prices include the contribution: show the taxable amount without it, the contribution
      // with its percentage, then their sum.
      rows.push(
        {
          label: t("pdf.taxableWithoutContribution"),
          value: money(totals.taxableWithoutContributionCents),
        },
        { label: contribution, value: money(totals.contributionCents) },
        { label: t("pdf.taxableTotal"), value: money(totals.taxableCents) },
      );
    } else {
      rows.push({
        label: `${contribution} (${t("pdf.cassa.excluded")})`,
        value: money(totals.contributionCents),
      });
    }
  }
  rows.push({ label: t("pdf.vat"), value: money(totals.vatCents) });
  if (totals.stampCents > 0) {
    rows.push({ label: t("pdf.stamp"), value: money(totals.stampCents) });
  }
  rows.push({ label: t("pdf.documentTotal"), value: money(totals.documentTotalCents) });
  if (totals.ritenutaCents > 0) {
    const calc = {
      rate: number.format(totals.ritenutaRateBp / 100),
      share: number.format(totals.ritenutaShareBp / 100),
      subject: money(totals.ritenutaSubjectCents),
      base: money(totals.ritenutaBaseCents),
    };
    rows.push({
      label: t(
        totals.ritenutaShareBp === 10000 ? "pdf.withheldCalc" : "pdf.withheldCalcShare",
        calc,
      ),
      value: `-${money(totals.ritenutaCents)}`,
    });
  }
  rows.push({
    label: t(credit ? "pdf.creditDue" : "pdf.amountDue"),
    value: money(totals.amountDueCents),
    strong: true,
  });

  const ritenuta = data.ritenuta
    ? t("pdf.ritenuta", { type: data.ritenuta.type, causale: data.ritenuta.causale })
    : null;

  const payment: PdfRow[] = [];
  const pay = data.payment;
  if (pay.method) {
    payment.push({ label: t("pdf.payment.method"), value: t(`pdf.methods.${pay.method}`) });
    if (pay.accountHolder) {
      payment.push({ label: t("pdf.payment.holder"), value: pay.accountHolder });
    }
    if (pay.bankName) payment.push({ label: t("pdf.payment.bank"), value: pay.bankName });
    if (pay.iban) payment.push({ label: t("pdf.payment.iban"), value: pay.iban });
    if (pay.bic) payment.push({ label: t("pdf.payment.bic"), value: pay.bic });
    if (invoice.dueDate) {
      payment.push({
        label: t("pdf.payment.dueDate"),
        value: formatDate(invoice.dueDate, language),
      });
    }
    payment.push({ label: t("pdf.payment.amount"), value: money(totals.amountDueCents) });
  }

  const meta: PdfRow[] = [{ label: t("pdf.currency"), value: currency }];
  const terms = pay.terms;
  if (terms) {
    meta.push({
      label: t("pdf.terms.label"),
      value: t(`pdf.terms.${terms.kind}`, { days: terms.kind === "custom" ? terms.days : 0 }),
    });
  }
  if (invoice.dueDate) {
    meta.push({ label: t("pdf.dueDate"), value: formatDate(invoice.dueDate, language) });
  }

  return {
    language,
    title: t(credit ? "pdf.creditNote" : "pdf.invoice"),
    numberLine: t("pdf.numberLine", {
      number: input.number,
      date: formatDate(input.issueDate, language),
    }),
    issuerName: issuer.name,
    issuerLines: issuerLines(issuer, t),
    clientName: client.name,
    clientLines: clientLines(client, t),
    meta,
    linked: input.linked
      ? t("pdf.linked", {
          number: input.linked.number,
          date: formatDate(input.linked.issueDate, language),
        })
      : null,
    lines,
    groups,
    naturaTexts,
    noteLines: data.note ? data.note.split(/\r?\n/) : [],
    totals: rows,
    ritenuta,
    payment,
    legalNote: t("pdf.legalNote"),
  };
}
