import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleX, Download, Ellipsis, Pencil } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { romeDateTime } from "../../shared/cron";
import { formatDate, type UiLocale } from "../../shared/format";
import type { InvoiceRecord } from "../../shared/invoice";
import { formatNumberWithYear } from "../../shared/numbering";
import { InvoiceDocumentView } from "../components/invoice-document-view";
import { Page } from "../components/page";
import { PaymentDialog } from "../components/payment-action";
import { Banner } from "../components/ui/banner";
import { MenuButton, type MenuItem } from "../components/ui/menu-button";
import { CreditNoteBadge, ImportedBadge, StatusBadge } from "../components/ui/status-badge";
import { type ImportedSeed, seedImportedForm } from "../import/imported-seed";
import { loadOriginal } from "../import/original";
import { INVOICE_LIST_BACK } from "../lib/back-links";
import { clientsQuery } from "../lib/clients-api";
import { downloadUrl } from "../lib/invoice-download";
import { useOnline } from "../lib/online";
import { paymentMethodsQuery } from "../lib/settings-api";

/**
 * A historic issued invoice that was never edited: the readable view of the file it was read from
 * (nothing without an original), its payment status, and a download of the original. Edit opens
 * the editor with a form built from that file (`onEdit`); it is never sent or deleted.
 */
export function ImportedInvoicePage({
  record,
  onEdit,
}: {
  record: InvoiceRecord;
  onEdit: (seed: ImportedSeed) => void;
}) {
  const { t, i18n } = useTranslation();
  const online = useOnline();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const [paying, setPaying] = useState(false);
  const clients = useQuery(clientsQuery);
  const accounts = useQuery(paymentMethodsQuery);
  const file = useQuery({
    queryKey: ["invoice", record.id, "original"],
    retry: false,
    // An import without an original file has nothing to read or download.
    enabled: record.hasOriginal,
    queryFn: () => loadOriginal(`/api/invoices/${record.id}/original`, "invoice.xml", "import"),
  });
  const paid = record.paymentFlag === "paid";
  const loaded = file.data;
  const credit = record.documentType === "TD04";
  // Edit needs the original read (or known unreadable) and the lists the form is built from.
  const reading = record.hasOriginal && file.isPending;
  const ready = !reading && clients.data !== undefined && accounts.data !== undefined;

  const items: MenuItem[] = [
    {
      key: "edit",
      label: t("invoice.actions.edit"),
      icon: <Pencil aria-hidden />,
      disabled: !ready,
      onSelect: () => {
        if (!clients.data || !accounts.data) return;
        const original = record.hasOriginal ? (loaded ?? "unreadable") : null;
        onEdit(
          seedImportedForm(record, clients.data.clients, accounts.data.paymentMethods, original),
        );
      },
    },
  ];
  if (!credit) {
    items.push({
      key: "payment",
      label: t(paid ? "invoice.paid.undo" : "invoice.paid.record"),
      icon: paid ? <CircleX aria-hidden /> : <CircleCheck aria-hidden />,
      disabled: !online,
      reason: online ? undefined : t("offline.reason"),
      onSelect: () => setPaying(true),
    });
  }
  if (record.hasOriginal) {
    items.push({
      key: "download-original",
      label: t("received.download"),
      icon: <Download aria-hidden />,
      separated: true,
      disabled: !online,
      reason: online ? undefined : t("offline.reason"),
      onSelect: () => downloadUrl(`/api/invoices/${record.id}/original`),
    });
  }
  return (
    <Page
      title={
        record.clientName ||
        t(credit ? "import.view.creditNote" : "import.view.invoice", {
          number: record.number ? formatNumberWithYear(record.number, record.year) : "",
        })
      }
      back={INVOICE_LIST_BACK}
      subtitle={
        [
          record.number
            ? t("invoice.numberYear", { number: formatNumberWithYear(record.number, record.year) })
            : null,
          record.issueDate ? formatDate(record.issueDate, locale) : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      }
      chips={
        <>
          <ImportedBadge />
          {credit ? <CreditNoteBadge /> : <StatusBadge status={record.paymentFlag} />}
        </>
      }
      actions={
        <MenuButton
          label={t("invoice.actions.more")}
          icon={<Ellipsis aria-hidden />}
          items={items}
          iconOnly
        />
      }
    >
      <Banner tone="info">
        {t(record.hasOriginal ? "import.view.fromFile" : "import.view.noOriginal")}
      </Banner>
      {reading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("received.view.reading")}
        </p>
      ) : null}
      {file.isError ? <Banner tone="danger">{t("received.view.unreadable")}</Banner> : null}
      {loaded ? <InvoiceDocumentView invoice={loaded.invoice} counterparty="customer" /> : null}
      <PaymentDialog
        record={record}
        today={romeDateTime(new Date()).date}
        open={paying}
        onOpenChange={setPaying}
      />
    </Page>
  );
}
