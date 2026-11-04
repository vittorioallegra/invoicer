import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ReceivedDocument, ReceivedInvoice, ReceivedParty } from "../../shared/fatturapa";
import { formatDate, formatMoney, type UiLocale } from "../../shared/format";
import { decimalToCents } from "../../shared/import";
import { documentTotalCents } from "../import/summary";
import { GroupBox } from "./ui/group-box";

function useLocale(): UiLocale {
  const { i18n } = useTranslation();
  return i18n.language.startsWith("it") ? "it" : "en";
}

/** An amount as written in the file: formatted money when it has at most two decimals, else as is. */
function useAmount(currency: string) {
  const locale = useLocale();
  return (value: string | null): string => {
    if (value === null || value === "") return "–";
    const cents = /^[+-]?\d+(\.\d{0,2})?$/.test(value.trim()) ? decimalToCents(value) : null;
    return cents === null ? `${value} ${currency}` : formatMoney(cents, locale, currency);
  };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right tabular-nums">{children}</dd>
    </div>
  );
}

function Party({ title, party }: { title: string; party: ReceivedParty }) {
  const { t } = useTranslation();
  const address = party.address;
  const place = [address.postalCode, address.city, address.province && `(${address.province})`]
    .filter(Boolean)
    .join(" ");
  return (
    <GroupBox title={title}>
      <p className="font-medium">{party.name || "–"}</p>
      <dl className="flex flex-col gap-1">
        {party.vatId ? (
          <Row label={t("received.view.vat")}>{`${party.vatId.country}${party.vatId.code}`}</Row>
        ) : null}
        {party.taxCode ? <Row label={t("received.view.taxCode")}>{party.taxCode}</Row> : null}
      </dl>
      <p className="text-sm text-muted-foreground">
        {[[address.street, address.streetNumber].filter(Boolean).join(" "), place, address.country]
          .filter(Boolean)
          .join(", ")}
      </p>
      {party.email || party.phone ? (
        <p className="text-sm text-muted-foreground">
          {[party.email, party.phone].filter(Boolean).join(" · ")}
        </p>
      ) : null}
    </GroupBox>
  );
}

function vatLabel(rate: string, natura: string | null): string {
  const percent = Number(rate);
  const shown = Number.isFinite(percent) ? `${percent}%` : rate;
  return natura ? `${shown} ${natura}` : shown;
}

function DocumentView({ document }: { document: ReceivedDocument }) {
  const { t, i18n } = useTranslation();
  const locale = useLocale();
  const amount = useAmount(document.currency);
  const total = documentTotalCents(document);
  const typeKey = `received.docType.${document.documentType}`;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">
          {i18n.exists(typeKey) ? t(typeKey) : document.documentType}
          {" · "}
          {t("received.view.number", { number: document.number })}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("received.view.dated", { date: formatDate(document.date, locale) })}
        </p>
      </div>

      {document.causali.length > 0 ? (
        <GroupBox title={t("received.view.causali")}>
          {document.causali.map((text) => (
            <p key={text} className="whitespace-pre-wrap break-words text-sm">
              {text}
            </p>
          ))}
        </GroupBox>
      ) : null}

      <GroupBox title={t("received.view.lines")}>
        <ul className="flex flex-col divide-y divide-border">
          {document.lines.map((line) => (
            <li
              key={line.number}
              className="flex items-start justify-between gap-4 py-2 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="whitespace-pre-wrap break-words font-medium">{line.description}</p>
                <p className="text-sm text-muted-foreground">
                  {[
                    line.quantity !== null
                      ? `${Number(line.quantity)}${line.unit ? ` ${line.unit}` : ""} × ${amount(line.unitPrice)}`
                      : null,
                    t("received.view.vatOf", { vat: vatLabel(line.vatRate, line.natura) }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <p className="shrink-0 font-medium tabular-nums">{amount(line.total)}</p>
            </li>
          ))}
        </ul>
      </GroupBox>

      {document.vatSummary.length > 0 ? (
        <GroupBox title={t("received.view.vatSummary")}>
          <dl className="flex flex-col gap-1">
            {document.vatSummary.map((row) => (
              <Row
                key={`${row.vatRate}-${row.natura ?? ""}`}
                label={t("received.view.vatSummaryRow", {
                  vat: vatLabel(row.vatRate, row.natura),
                  taxable: amount(row.taxable),
                })}
              >
                {amount(row.vat)}
              </Row>
            ))}
          </dl>
        </GroupBox>
      ) : null}

      <GroupBox title={t("received.view.totals")}>
        <dl className="flex flex-col gap-1">
          {document.stamp ? (
            <Row label={t("received.view.stamp")}>{amount(document.stamp.amount)}</Row>
          ) : null}
          {document.withholding.map((item) => (
            <Row
              key={`${item.type}-${item.amount}`}
              label={t("received.view.withholding", { type: item.type })}
            >
              {amount(item.amount)}
            </Row>
          ))}
          <Row label={t("received.view.total")}>
            <span className="text-base font-semibold">
              {total === null ? "–" : formatMoney(total, locale, document.currency)}
            </span>
          </Row>
        </dl>
      </GroupBox>

      {document.payments.length > 0 ? (
        <GroupBox title={t("received.view.payment")}>
          <ul className="flex flex-col divide-y divide-border">
            {document.payments.map((payment) => (
              <li
                key={`${payment.method}-${payment.dueDate ?? ""}-${payment.amount}-${payment.iban ?? ""}`}
                className="py-2 first:pt-0 last:pb-0"
              >
                <dl className="flex flex-col gap-1">
                  <Row label={t("received.view.method")}>
                    {i18n.exists(`invoice.paymentMethods.${payment.method}`)
                      ? t(`invoice.paymentMethods.${payment.method}`)
                      : payment.method}
                  </Row>
                  <Row label={t("received.view.amount")}>{amount(payment.amount)}</Row>
                  {payment.dueDate ? (
                    <Row label={t("received.view.dueDate")}>
                      {formatDate(payment.dueDate, locale)}
                    </Row>
                  ) : null}
                  {payment.iban ? <Row label="IBAN">{payment.iban}</Row> : null}
                  {payment.bankName ? (
                    <Row label={t("received.view.bank")}>{payment.bankName}</Row>
                  ) : null}
                </dl>
              </li>
            ))}
          </ul>
        </GroupBox>
      ) : null}

      {document.linked.length > 0 ? (
        <GroupBox title={t("received.view.linked")}>
          {document.linked.map((item) => (
            <p key={`${item.number}-${item.date ?? ""}`} className="text-sm">
              {item.date
                ? t("received.view.linkedRow", {
                    number: item.number,
                    date: formatDate(item.date, locale),
                  })
                : item.number}
            </p>
          ))}
        </GroupBox>
      ) : null}
    </div>
  );
}

/**
 * The readable view of a FatturaPA invoice file (supplier, customer, lines, totals, payment
 * data). Everything is rendered as text; the file's own values are never interpreted as markup.
 */
export function InvoiceDocumentView({ invoice }: { invoice: ReceivedInvoice }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Party title={t("received.view.supplier")} party={invoice.supplier} />
        <Party title={t("received.view.customer")} party={invoice.customer} />
      </div>
      {invoice.documents.map((document, index) => (
        // The order of the documents in a file is fixed, so the index is a stable key.
        // biome-ignore lint/suspicious/noArrayIndexKey: documents have no id of their own
        <DocumentView key={index} document={document} />
      ))}
    </div>
  );
}
