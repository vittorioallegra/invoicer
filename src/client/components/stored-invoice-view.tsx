import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatDate, formatMoney, type UiLocale } from "../../shared/format";
import { cassaTypeLabel } from "../../shared/totals";
import { bpToText } from "../lib/invoice-form";
import type { InvoiceView, ViewLine } from "../lib/invoice-view";
import { LineList, PartyBox, Row } from "./invoice-document-parts";
import { GroupBox } from "./ui/group-box";

function vatText(rateBp: number | null, natura: string | null): string | null {
  if (rateBp !== null) return `${bpToText(rateBp)}%`;
  return natura;
}

/**
 * The compact, read-only page of a stored invoice (view mode): the customer, note, lines, VAT
 * summary, totals and payment, from the same cents the editor's totals engine computes. Every
 * value is rendered as text; the stored text is never interpreted as markup.
 */
export function StoredInvoiceView({
  view,
  locale,
  cassa,
  customerNotes,
  lineNotes,
}: {
  view: InvoiceView;
  locale: UiLocale;
  /** The cassa type code of the invoice ("" for none), for the contribution label. */
  cassa: string;
  /** Shown above the customer and the lines (the SdI errors that concern them). */
  customerNotes?: ReactNode;
  lineNotes?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const money = (cents: number) => formatMoney(cents, locale, view.currency);
  const { totals, payment, customer } = view;

  const lineItems = view.lines.map((line: ViewLine, index) => {
    const vat = vatText(line.vatRateBp, line.natura);
    return {
      key: `line-${index}`,
      description: line.description,
      note: line.note,
      detail: [
        line.quantity !== "" && line.unitPriceCents !== null
          ? `${line.quantity}${line.unit ? ` ${line.unit}` : ""} × ${money(line.unitPriceCents)}`
          : null,
        vat ? t("received.view.vatOf", { vat }) : null,
      ]
        .filter(Boolean)
        .join(" · "),
      total: money(line.amountCents),
    };
  });
  // The stamp duty charged to the client is a generated line of the invoice.
  if (totals?.stampLine) {
    lineItems.push({
      key: "stamp",
      description: t("invoice.lines.stampLine"),
      note: "",
      detail: `${t("invoice.lines.stampLineHint")} · ${totals.stampLine.natura}`,
      total: money(totals.stampLine.totals.amountCents),
    });
  }

  const customerRows: { label: string; value: string }[] = [];
  if (customer?.vatId) customerRows.push({ label: t("received.view.vat"), value: customer.vatId });
  if (customer?.taxCode) {
    customerRows.push({ label: t("received.view.taxCode"), value: customer.taxCode });
  }
  if (customer?.recipientCode) {
    customerRows.push({ label: t("clients.form.recipientCode"), value: customer.recipientCode });
  }
  if (customer?.pec) customerRows.push({ label: t("clients.form.pec"), value: customer.pec });

  const hasRitenuta = (totals?.ritenutaCents ?? 0) > 0;
  const termsText = payment.terms
    ? payment.terms.kind === "custom"
      ? t("invoice.view.customDays", { days: payment.terms.days })
      : t(`paymentTerms.kind_${payment.terms.kind}`)
    : null;
  const paymentShown =
    termsText !== null ||
    payment.method !== null ||
    payment.iban !== null ||
    payment.bankName !== null;

  return (
    <section aria-label={t("invoice.view.title")} className="flex flex-col gap-6">
      {customerNotes}
      {customer ? (
        <PartyBox
          title={t("received.view.customer")}
          rows={customerRows}
          address={customer.address}
          contacts={customer.email ?? ""}
        />
      ) : null}

      <GroupBox title={t("invoice.document.title")}>
        <dl className="flex flex-col gap-1">
          <Row label={t("invoice.document.type")}>
            {t(view.credit ? "invoice.document.td04" : "invoice.document.td01")}
          </Row>
          {view.seriesName ? (
            <Row label={t("invoice.document.series")}>{view.seriesName}</Row>
          ) : null}
          <Row label={t("invoice.document.language")}>
            {t(
              view.language === "en"
                ? "invoice.document.languageEn"
                : "invoice.document.languageIt",
            )}
          </Row>
          {view.currency !== "EUR" ? (
            <Row label={t("invoice.document.currency")}>{view.currency}</Row>
          ) : null}
          {view.credit && view.linkedNumber ? (
            <Row label={t("invoice.document.linked")}>{view.linkedNumber}</Row>
          ) : null}
        </dl>
      </GroupBox>

      {view.note ? (
        <GroupBox title={t("received.view.causali")}>
          <p className="whitespace-pre-wrap break-words text-sm">{view.note}</p>
        </GroupBox>
      ) : null}

      <GroupBox title={t("invoice.lines.title")}>
        {lineNotes}
        {lineItems.length > 0 ? (
          <LineList lines={lineItems} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("invoice.view.noLines")}</p>
        )}
      </GroupBox>

      {totals && totals.groups.length > 0 ? (
        <GroupBox title={t("received.view.vatSummary")}>
          <dl className="flex flex-col gap-1">
            {totals.groups.map((group) => (
              <Row
                key={group.key}
                label={t("received.view.vatSummaryRow", {
                  vat: vatText(group.vatRateBp, group.natura) ?? "",
                  taxable: money(group.taxableCents),
                })}
              >
                {money(group.vatCents)}
              </Row>
            ))}
          </dl>
        </GroupBox>
      ) : null}

      <GroupBox title={t("invoice.totals.title")}>
        {totals ? (
          <dl className="flex flex-col gap-1">
            <Row label={t("invoice.view.taxable")}>
              {money(totals.taxableWithoutContributionCents)}
            </Row>
            {totals.contributionCents > 0 ? (
              <Row
                label={t("invoice.totals.contribution", {
                  label:
                    cassa === "rivalsa_inps"
                      ? t("invoice.totals.rivalsa")
                      : cassaTypeLabel(cassa, locale),
                  rate: bpToText(totals.contributionRateBp),
                })}
              >
                {money(totals.contributionCents)}
              </Row>
            ) : null}
            <Row label={t("invoice.totals.vat")}>{money(totals.vatCents)}</Row>
            {view.stampBorneByIssuer ? (
              <Row label={t("invoice.totals.stamp")}>{t("invoice.extras.bolloIssuer")}</Row>
            ) : null}
            {totals.stampCents > 0 ? (
              <Row label={t("invoice.totals.stamp")}>{money(totals.stampCents)}</Row>
            ) : null}
            <Row label={t("invoice.totals.documentTotal")}>
              <span className={hasRitenuta ? undefined : "text-base font-semibold"}>
                {money(totals.documentTotalCents)}
              </span>
            </Row>
            {hasRitenuta ? (
              <>
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
                >
                  −{money(totals.ritenutaCents)}
                </Row>
                <Row label={t(view.credit ? "invoice.totals.creditDue" : "invoice.totals.due")}>
                  <span className="text-base font-semibold">{money(totals.amountDueCents)}</span>
                </Row>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t("invoice.view.noTotals")}</p>
        )}
      </GroupBox>

      {paymentShown ? (
        <GroupBox title={t("invoice.payment.title")}>
          <dl className="flex flex-col gap-1">
            {termsText ? <Row label={t("paymentTerms.label")}>{termsText}</Row> : null}
            {payment.dueDate ? (
              <Row label={t("received.view.dueDate")}>{formatDate(payment.dueDate, locale)}</Row>
            ) : null}
            {payment.method ? (
              <Row label={t("received.view.method")}>
                {i18n.exists(`invoice.paymentMethods.${payment.method}`)
                  ? t(`invoice.paymentMethods.${payment.method}`)
                  : payment.method}
              </Row>
            ) : null}
            {payment.iban ? <Row label="IBAN">{payment.iban}</Row> : null}
            {payment.bic ? <Row label="BIC">{payment.bic}</Row> : null}
            {payment.accountHolder ? (
              <Row label={t("invoice.view.accountHolder")}>{payment.accountHolder}</Row>
            ) : null}
            {payment.bankName ? (
              <Row label={t("received.view.bank")}>{payment.bankName}</Row>
            ) : null}
          </dl>
        </GroupBox>
      ) : null}
    </section>
  );
}
