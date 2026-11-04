import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { romeDateTime } from "../../shared/cron";
import { formatDate, formatMoney, type UiLocale } from "../../shared/format";
import type { InvoiceRecord } from "../../shared/invoice";
import { formatNumberWithYear } from "../../shared/numbering";
import { InvoiceDocumentView } from "../components/invoice-document-view";
import { Page } from "../components/page";
import { PaymentDialog } from "../components/payment-action";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { ImportedBadge, StatusBadge } from "../components/ui/status-badge";
import { loadOriginal, originalType } from "../import/original";
import { INVOICE_LIST_BACK } from "../lib/back-links";
import { downloadBytes } from "../lib/invoice-download";
import { useOnline } from "../lib/online";

/**
 * A historic issued invoice read from a file: the readable view of the original, its payment
 * status, and a download of the original. It cannot be edited, sent, duplicated or deleted.
 */
export function ImportedInvoicePage({ record }: { record: InvoiceRecord }) {
  const { t, i18n } = useTranslation();
  const online = useOnline();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const [paying, setPaying] = useState(false);
  const file = useQuery({
    queryKey: ["invoice", record.id, "original"],
    retry: false,
    queryFn: () => loadOriginal(`/api/invoices/${record.id}/original`, "invoice.xml", "import"),
  });
  const paid = record.paymentFlag === "paid";
  const loaded = file.data;
  const credit = record.documentType === "TD04";
  return (
    <Page
      title={t(credit ? "import.view.creditNote" : "import.view.invoice", {
        number: record.number ? formatNumberWithYear(record.number, record.year) : "",
      })}
      back={INVOICE_LIST_BACK}
      subtitle={[
        record.clientName,
        record.issueDate ? formatDate(record.issueDate, locale) : null,
        record.totalCents === null ? null : formatMoney(record.totalCents, locale, record.currency),
      ]
        .filter(Boolean)
        .join(" · ")}
      aside={
        <>
          <ImportedBadge />
          {credit ? null : <StatusBadge status={record.paymentFlag} />}
          {credit ? null : (
            <Button variant="secondary" disabled={!online} onClick={() => setPaying(true)}>
              {t(paid ? "invoice.paid.undo" : "invoice.paid.record")}
            </Button>
          )}
          {loaded ? (
            <Button
              variant="secondary"
              onClick={() =>
                downloadBytes(loaded.bytes, loaded.fileName, originalType(loaded.fileName))
              }
            >
              <Download aria-hidden />
              {t("received.download")}
            </Button>
          ) : null}
        </>
      }
    >
      <Banner tone="info">{t("import.view.readOnly")}</Banner>
      {file.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("received.view.reading")}
        </p>
      ) : null}
      {file.isError ? <Banner tone="danger">{t("received.view.unreadable")}</Banner> : null}
      {loaded ? <InvoiceDocumentView invoice={loaded.invoice} /> : null}
      <PaymentDialog
        record={record}
        today={romeDateTime(new Date()).date}
        open={paying}
        onOpenChange={setPaying}
      />
    </Page>
  );
}
