import type { IssuedSummaryDraftRow, SummaryAmounts } from "./import";
import type { InvoiceBody } from "./invoice";
import { assembleDraft, type DraftContext } from "./invoice-draft";
import type { TaxOptions } from "./tax";

/**
 * The unsent invoice rebuilt from a Fatture in Cloud account summary row dated after today. The
 * summary has no lines, so the invoice gets one line with the taxable amount; cassa and ritenuta
 * come from the owner's Tax details when the row has them. The editor recalculates every total
 * from its own engine, so they can differ slightly from the summary; the owner checks them.
 */

/** The VAT rates the invoice line may be given from the amounts, in basis points. */
const INFERRED_RATES = [400, 500, 1000, 2200] as const;

/**
 * VAT rate implied by the amounts: IVA over (taxable + rivalsa + cassa + other cassa) when it is
 * within 0.5 percentage points of a standard rate; null otherwise (no VAT, or an unusual rate).
 */
export function inferVatRateBp(amounts: SummaryAmounts): number | null {
  const base =
    amounts.taxableCents + amounts.rivalsaCents + amounts.cassaCents + amounts.otherCassaCents;
  if (base <= 0 || amounts.taxCents <= 0) return null;
  const percent = (amounts.taxCents / base) * 100;
  return INFERRED_RATES.find((rate) => Math.abs(percent - rate / 100) <= 0.5) ?? null;
}

export interface SummaryDraftContext extends DraftContext {
  tax: TaxOptions;
}

export function buildSummaryDraft(
  row: IssuedSummaryDraftRow,
  context: SummaryDraftContext,
): InvoiceBody {
  const { amounts } = row;
  const hasCassa = amounts.cassaCents + amounts.rivalsaCents + amounts.otherCassaCents > 0;
  const cassa =
    hasCassa && context.tax.cassa ? { ...context.tax.cassa, mode: "excluded" as const } : null;
  const ritenuta = amounts.withholdingCents > 0 ? context.tax.ritenuta : null;
  return assembleDraft(
    {
      documentType: row.documentType,
      currency: "EUR",
      date: row.date,
      lines: [
        {
          description: "",
          note: "",
          quantityMilli: 1000,
          unit: null,
          unitPriceCents: Math.abs(amounts.taxableCents),
          vatRateBp: inferVatRateBp(amounts),
          natura: null,
        },
      ],
      cassa,
      ritenuta,
      bollo: "none",
      note: "",
      payment: null,
    },
    context,
  );
}
