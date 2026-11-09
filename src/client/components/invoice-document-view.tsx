import { useTranslation } from "react-i18next";
import type { ReceivedDocument, ReceivedInvoice, ReceivedParty } from "../../shared/fatturapa";
import { formatDate, formatMoney, type UiLocale } from "../../shared/format";
import { decimalToCents } from "../../shared/import";
import { documentTotalCents } from "../import/summary";
import { LineList, PartyBox, Row } from "./invoice-document-parts";
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

/** The name is left out when the page title already shows it. */
function Party({ title, party }: { title: string; party: ReceivedParty }) {
  const { t } = useTranslation();
  const address = party.address;
  const place = [address.postalCode, address.city, address.province && `(${address.province})`]
    .filter(Boolean)
    .join(" ");
  const rows: { label: string; value: string }[] = [];
  if (party.vatId) {
    rows.push({
      label: t("received.view.vat"),
      value: `${party.vatId.country}${party.vatId.code}`,
    });
  }
  if (party.taxCode) rows.push({ label: t("received.view.taxCode"), value: party.taxCode });
  return (
    <PartyBox
      title={title}
      rows={rows}
      address={[
        [address.street, address.streetNumber].filter(Boolean).join(" "),
        place,
        address.country,
      ]
        .filter(Boolean)
        .join(", ")}
      contacts={[party.email, party.phone].filter(Boolean).join(" · ")}
    />
  );
}

function vatLabel(rate: string, natura: string | null): string {
  const percent = Number(rate);
  const shown = Number.isFinite(percent) ? `${percent}%` : rate;
  return natura ? `${shown} ${natura}` : shown;
}

function DocumentView({
  document,
  showHeader,
}: {
  document: ReceivedDocument;
  /** Hidden for a file with one document: its type, number and date are in the page title. */
  showHeader: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = useLocale();
  const amount = useAmount(document.currency);
  const total = documentTotalCents(document);
  const typeKey = `received.docType.${document.documentType}`;
  return (
    <div className="flex flex-col gap-6">
      {showHeader ? (
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
      ) : null}

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
        <LineList
          lines={document.lines.map((line) => ({
            key: String(line.number),
            description: line.description,
            detail: [
              line.quantity !== null
                ? `${Number(line.quantity)}${line.unit ? ` ${line.unit}` : ""} × ${amount(line.unitPrice)}`
                : null,
              t("received.view.vatOf", { vat: vatLabel(line.vatRate, line.natura) }),
            ]
              .filter(Boolean)
              .join(" · "),
            total: amount(line.total),
          }))}
        />
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
export function InvoiceDocumentView({
  invoice,
  counterparty,
}: {
  invoice: ReceivedInvoice;
  /**
   * The party shown: the supplier on a received invoice, the customer on an issued one. The
   * owner's own block is never shown, and neither is the counterparty's name (the page title).
   */
  counterparty: "supplier" | "customer";
}) {
  const { t } = useTranslation();
  const single = invoice.documents.length === 1;
  return (
    <div className="flex flex-col gap-6">
      <Party
        title={t(counterparty === "supplier" ? "received.view.supplier" : "received.view.customer")}
        party={counterparty === "supplier" ? invoice.supplier : invoice.customer}
      />
      {invoice.documents.map((document, index) => (
        // The order of the documents in a file is fixed, so the index is a stable key.
        // biome-ignore lint/suspicious/noArrayIndexKey: documents have no id of their own
        <DocumentView key={index} document={document} showHeader={!single} />
      ))}
    </div>
  );
}
