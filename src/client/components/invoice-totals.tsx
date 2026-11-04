import { ChevronUp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMoney, type UiLocale } from "../../shared/format";
import type { Totals } from "../../shared/totals";
import { type CassaType, cassaTypeLabel } from "../../shared/totals";
import { bpToText, type InvoiceForm } from "../lib/invoice-form";

export interface InvoiceTotalsProps {
  totals: Totals | null;
  form: InvoiceForm;
  locale: UiLocale;
}

/** Sticky footer: amount due and an expandable breakdown. */
export function InvoiceTotals({ totals, form, locale }: InvoiceTotalsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const currency = form.currency.toUpperCase();
  const money = (cents: number) => formatMoney(cents, locale, currency);
  const credit = form.documentType === "TD04";
  const included = form.cassaMode === "included";
  const contributionLabel = t("invoice.totals.contribution", {
    label:
      form.cassaType === "rivalsa_inps"
        ? t("invoice.totals.rivalsa")
        : cassaTypeLabel(form.cassaType as CassaType, locale),
    rate: totals ? bpToText(totals.contributionRateBp) : "",
  });

  return (
    <>
      {/* Phones: room for the fixed bar below, so the last fields stay reachable. */}
      <div aria-hidden className="h-8 md:hidden" />
      <section
        aria-label={t("invoice.totals.title")}
        className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 border-t border-border bg-surface px-4 py-3 shadow-[0_-4px_12px_rgb(0_0_0/0.06)] md:sticky md:inset-x-auto md:bottom-8 md:rounded-card md:border"
      >
        {open && totals ? (
          <dl
            id="invoice-breakdown"
            className="mb-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-b border-border pb-3 text-sm"
          >
            {included && totals.contributionCents > 0 ? (
              <>
                <Row
                  label={t("invoice.totals.taxableWithout")}
                  value={money(totals.taxableWithoutContributionCents)}
                />
                <Row label={contributionLabel} value={money(totals.contributionCents)} />
                <Row label={t("invoice.totals.taxableTotal")} value={money(totals.taxableCents)} />
              </>
            ) : null}
            {/* One VAT group would only repeat the sum above. */}
            {!(included && totals.contributionCents > 0 && totals.groups.length === 1)
              ? totals.groups.map((group) => (
                  <Row
                    key={group.key}
                    label={
                      group.vatRateBp === null
                        ? t("invoice.totals.taxableNatura", { code: group.natura })
                        : t("invoice.totals.taxableRate", { rate: bpToText(group.vatRateBp) })
                    }
                    value={money(group.taxableCents)}
                  />
                ))
              : null}
            {!included && totals.contributionCents > 0 ? (
              <Row
                label={`${contributionLabel} (${t("invoice.totals.addedOnTop")})`}
                value={money(totals.contributionCents)}
              />
            ) : null}
            <Row label={t("invoice.totals.vat")} value={money(totals.vatCents)} />
            {totals.stampCents > 0 ? (
              <Row label={t("invoice.totals.stamp")} value={money(totals.stampCents)} />
            ) : null}
            <Row
              label={t("invoice.totals.documentTotal")}
              value={money(totals.documentTotalCents)}
            />
            {totals.ritenutaCents > 0 ? (
              <Row
                label={
                  totals.ritenutaShareBp === 10000
                    ? t("invoice.totals.ritenutaCalc", {
                        rate: bpToText(totals.ritenutaRateBp),
                        subject: money(totals.ritenutaSubjectCents),
                      })
                    : t("invoice.totals.ritenutaCalcShare", {
                        rate: bpToText(totals.ritenutaRateBp),
                        share: bpToText(totals.ritenutaShareBp),
                        subject: money(totals.ritenutaSubjectCents),
                        base: money(totals.ritenutaBaseCents),
                      })
                }
                value={`−${money(totals.ritenutaCents)}`}
              />
            ) : null}
          </dl>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            aria-expanded={open}
            aria-controls="invoice-breakdown"
            onClick={() => setOpen((value) => !value)}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className="min-w-0">
              <span className="block text-sm text-muted-foreground">
                {t(credit ? "invoice.totals.creditDue" : "invoice.totals.due")}
              </span>
              <span className="block text-xl font-semibold tabular-nums">
                {totals ? money(totals.amountDueCents) : "–"}
              </span>
            </span>
            <ChevronUp
              aria-hidden
              className={`ml-auto size-5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
            />
            <span className="sr-only">{t("invoice.totals.breakdown")}</span>
          </button>
        </div>
      </section>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </>
  );
}
