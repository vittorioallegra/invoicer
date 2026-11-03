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

/** Description of the generated stamp line in the XML (Italian, like the other legal texts). */
export const STAMP_LINE_DESCRIPTION = "Imposta di bollo";

/**
 * The natura of the generated stamp line: that of the no-VAT lines, the one with the largest
 * total when there are several (first in line order on a tie); null without a natura line.
 */
export function stampLineNatura(lines: readonly TotalsLine[]): Natura | null {
  const totals = new Map<Natura, number>();
  for (const line of lines) {
    if (line.natura === null) continue;
    totals.set(
      line.natura,
      (totals.get(line.natura) ?? 0) + divRound(line.quantityMilli * line.unitPriceCents, 1000),
    );
  }
  let best: Natura | null = null;
  let bestAmount = Number.NEGATIVE_INFINITY;
  for (const [natura, amount] of totals) {
    if (amount > bestAmount) {
      best = natura;
      bestAmount = amount;
    }
  }
  return best;
}

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
  const charge = input.bolloCharge ?? "client";

  // Bollo charged to the client: a generated line of the stamp amount, with the natura of the
  // no-VAT lines (the largest total, first in line order on a tie), calculated like any line.
  const stampNatura = input.bollo && charge === "client" ? stampLineNatura(input.lines) : null;
  const stampInput: TotalsLine | null = stampNatura
    ? {
        description: STAMP_LINE_DESCRIPTION,
        quantityMilli: 1000,
        unitPriceCents: STAMP_CENTS,
        vatRateBp: null,
        natura: stampNatura,
      }
    : null;
  const allLines: readonly TotalsLine[] = stampInput ? [...input.lines, stampInput] : input.lines;

  const lineTotals: LineTotals[] = allLines.map((line) => {
    const amountCents = divRound(line.quantityMilli * line.unitPriceCents, 1000);
    if (cassa?.mode === "included") {
      const { base, contribution } = splitIncluded(amountCents, cassa);
      return { amountCents, baseCents: base, contributionCents: contribution };
    }
    return { amountCents, baseCents: amountCents, contributionCents: 0 };
  });

  // Group lines by VAT rate / natura, in order of first appearance.
  const byKey = new Map<string, { line: TotalsLine; base: number; contribution: number }>();
  allLines.forEach((line, i) => {
    const key = groupKey(line);
    const totals = lineTotals[i] as LineTotals;
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

  const linesBase = lineTotals.reduce((sum, l) => sum + l.baseCents, 0);
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
    (sum, line, i) => sum + (line.natura !== null ? (lineTotals[i] as LineTotals).amountCents : 0),
    0,
  );

  // Stored invoices ("legacy") add the stamp to the total without a line; "client" has its line
  // in the groups above and "issuer" leaves the total alone.
  const stampCents = input.bollo && charge === "legacy" ? STAMP_CENTS : 0;
  const documentTotalCents = taxableCents + vatCents + stampCents;
  const amountDueCents = documentTotalCents - ritenutaCents;
  const sign = input.documentType === "TD04" ? -1 : 1;

  return {
    currency: input.currency,
    documentType: input.documentType,
    sign,
    lines: lineTotals.slice(0, input.lines.length),
    stampLine:
      stampNatura && stampInput
        ? {
            natura: stampNatura,
            description: STAMP_LINE_DESCRIPTION,
            totals: lineTotals[input.lines.length] as LineTotals,
          }
        : null,
    bolloApplied: input.bollo,
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
