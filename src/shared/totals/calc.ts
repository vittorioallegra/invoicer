import { divRound } from "./money";
import type {
  CassaInput,
  CassaType,
  LineTotals,
  Natura,
  Totals,
  TotalsInput,
  TotalsLine,
  VatGroup,
} from "./types";

/** Bollo virtuale in cents. */
export const STAMP_CENTS = 200;
/** Natura amounts strictly above this (77.47 EUR) call for the stamp. */
export const STAMP_THRESHOLD_CENTS = 7747;

/**
 * Rivalsa INPS (TC22, gestione separata) is subject to ritenuta by default; the other casse
 * previdenziali (TC01-TC21) are not.
 */
export function defaultCassaSubjectToRitenuta(type: CassaType): boolean {
  return type === "rivalsa_inps" || type === "TC22";
}

const mulRate = (cents: number, rateBp: number) => divRound(cents * rateBp, 10000);

function groupKey(line: TotalsLine): string {
  const hasRate = line.vatRateBp !== null && line.vatRateBp > 0;
  const hasNatura = line.natura !== null;
  if (hasRate === hasNatura) {
    throw new Error("A line needs either a VAT rate above zero or a natura code, not both");
  }
  return hasNatura ? `natura:${line.natura}` : `vat:${line.vatRateBp}`;
}

function splitIncluded(amount: number, cassa: CassaInput): { base: number; contribution: number } {
  const base = divRound(amount * 10000, 10000 + cassa.rateBp);
  return { base, contribution: amount - base };
}

/** Computes every total of an invoice in integer cents of the document currency. */
export function computeTotals(input: TotalsInput): Totals {
  const cassa = input.cassa ?? null;

  const lines: LineTotals[] = input.lines.map((line) => {
    const amountCents = divRound(line.quantityMilli * line.unitPriceCents, 1000);
    if (cassa?.mode === "included") {
      const { base, contribution } = splitIncluded(amountCents, cassa);
      return { amountCents, baseCents: base, contributionCents: contribution };
    }
    return { amountCents, baseCents: amountCents, contributionCents: 0 };
  });

  // Group lines by VAT rate / natura, in order of first appearance.
  const byKey = new Map<string, { line: TotalsLine; base: number; contribution: number }>();
  input.lines.forEach((line, i) => {
    const key = groupKey(line);
    const totals = lines[i] as LineTotals;
    const group = byKey.get(key) ?? { line, base: 0, contribution: 0 };
    group.base += totals.baseCents;
    group.contribution += totals.contributionCents;
    byKey.set(key, group);
  });

  const groups: VatGroup[] = [];
  let contributionCents = 0;
  for (const [key, g] of byKey) {
    // The contribution takes the group's VAT rate (or natura).
    const contribution =
      cassa && cassa.mode === "excluded" ? mulRate(g.base, cassa.rateBp) : g.contribution;
    contributionCents += contribution;
    const taxableCents = g.base + contribution;
    const vatRateBp = g.line.vatRateBp !== null && g.line.vatRateBp > 0 ? g.line.vatRateBp : null;
    groups.push({
      key,
      vatRateBp,
      natura: (g.line.natura as Natura | null) ?? null,
      taxableCents,
      vatCents: vatRateBp === null ? 0 : mulRate(taxableCents, vatRateBp),
    });
  }

  const taxableCents = groups.reduce((sum, g) => sum + g.taxableCents, 0);
  const vatCents = groups.reduce((sum, g) => sum + g.vatCents, 0);

  const linesBase = lines.reduce((sum, l) => sum + l.baseCents, 0);
  // The rate applies to the base share (default 100%) of the amount subject to ritenuta; the
  // reduced base is rounded to the cent first, as the amount shown on the document.
  const ritenutaSubjectCents = input.ritenuta
    ? linesBase + (cassa?.subjectToRitenuta ? contributionCents : 0)
    : 0;
  const ritenutaBaseCents = input.ritenuta
    ? mulRate(ritenutaSubjectCents, input.ritenuta.baseBp ?? 10000)
    : 0;
  const ritenutaCents = input.ritenuta ? mulRate(ritenutaBaseCents, input.ritenuta.rateBp) : 0;

  const naturaAmountCents = input.lines.reduce(
    (sum, line, i) => sum + (line.natura !== null ? (lines[i] as LineTotals).amountCents : 0),
    0,
  );

  const stampCents = input.bollo ? STAMP_CENTS : 0;
  const documentTotalCents = taxableCents + vatCents + stampCents;
  const amountDueCents = documentTotalCents - ritenutaCents;
  const sign = input.documentType === "TD04" ? -1 : 1;

  return {
    currency: input.currency,
    documentType: input.documentType,
    sign,
    lines,
    groups,
    contributionRateBp: cassa?.rateBp ?? 0,
    contributionCents,
    taxableCents,
    taxableWithoutContributionCents: taxableCents - contributionCents,
    vatCents,
    ritenutaRateBp: input.ritenuta?.rateBp ?? 0,
    ritenutaShareBp: input.ritenuta ? (input.ritenuta.baseBp ?? 10000) : 0,
    ritenutaSubjectCents,
    ritenutaBaseCents,
    ritenutaCents,
    stampCents,
    documentTotalCents,
    amountDueCents,
    signedAmountDueCents: sign * amountDueCents,
    naturaAmountCents,
    bolloSuggested: naturaAmountCents > STAMP_THRESHOLD_CENTS,
  };
}
