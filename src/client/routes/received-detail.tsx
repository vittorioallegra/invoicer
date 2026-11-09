import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { CircleCheck, CircleX, Download, Ellipsis, Pencil } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDate, formatMoney, type UiLocale } from "../../shared/format";
import { InvoiceDocumentView } from "../components/invoice-document-view";
import { Page } from "../components/page";
import { ReceivedEditSheet } from "../components/received-edit-sheet";
import { Banner } from "../components/ui/banner";
import { MenuButton, type MenuItem } from "../components/ui/menu-button";
import { StatusBadge } from "../components/ui/status-badge";
import { toast } from "../components/ui/toast";
import { loadOriginal, originalType } from "../import/original";
import { summarizeInvoice } from "../import/summary";
import { RECEIVED_BACK } from "../lib/back-links";
import { downloadBytes } from "../lib/invoice-download";
import { useOnline } from "../lib/online";
import {
  receivedFileUrl,
  receivedQuery,
  reportParsed,
  setReceivedPayment,
} from "../lib/received-api";

export function ReceivedDetailPage() {
  const { t, i18n } = useTranslation();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const online = useOnline();
  const queryClient = useQueryClient();
  const { receivedId } = useParams({ strict: false }) as { receivedId: string };
  const record = useQuery(receivedQuery(receivedId));
  const original = record.data?.received.original;
  const kind = original?.kind;
  const file = useQuery({
    queryKey: ["received", receivedId, "original", original?.fileName, kind],
    enabled: original !== undefined && original !== null,
    retry: false,
    queryFn: async () => {
      const loaded = await loadOriginal(
        receivedFileUrl(receivedId),
        original?.fileName ?? "invoice.xml",
        kind ?? "received",
      );
      // The list shows what the browser found: report it once for an invoice not read yet.
      if (record.data?.received.parseStatus !== "parsed") {
        const summary = summarizeInvoice(loaded.invoice);
        await reportParsed(receivedId, summary ? { summary } : null).catch(() => undefined);
        await queryClient.invalidateQueries({ queryKey: ["received"], exact: true });
      }
      return loaded;
    },
  });

  const pay = useMutation({
    mutationFn: (paid: boolean) => setReceivedPayment(receivedId, paid),
    onSuccess: async (_data, paid) => {
      await queryClient.invalidateQueries({ queryKey: ["received"] });
      toast.success(t(paid ? "invoice.paid.recorded" : "invoice.paid.undone"));
    },
    onError: () => toast.error(t("common.error")),
  });

  const [editing, setEditing] = useState(false);
  const data = record.data?.received;
  const paid = data?.paymentFlag === "paid";
  const loaded = file.data;
  // The actions live in one "⋯" menu, like on the other invoice pages.
  const items: MenuItem[] = [];
  if (data?.parseStatus === "parsed") {
    items.push({
      key: "edit",
      label: t("received.edit.action"),
      icon: <Pencil aria-hidden />,
      disabled: !online,
      reason: online ? undefined : t("offline.reason"),
      onSelect: () => setEditing(true),
    });
  }
  if (data) {
    items.push({
      key: "payment",
      label: t(paid ? "received.markUnpaid" : "received.markPaid"),
      icon: paid ? <CircleX aria-hidden /> : <CircleCheck aria-hidden />,
      disabled: !online || pay.isPending,
      reason: online ? undefined : t("offline.reason"),
      onSelect: () => pay.mutate(!paid),
    });
  }
  if (loaded) {
    items.push({
      key: "download-original",
      label: t("received.download"),
      icon: <Download aria-hidden />,
      separated: true,
      onSelect: () => downloadBytes(loaded.bytes, loaded.fileName, originalType(loaded.fileName)),
    });
  }
  return (
    <Page
      title={data?.supplierName ?? t("pages.received.title")}
      back={RECEIVED_BACK}
      subtitle={
        data
          ? [
              data.number ? t("received.view.number", { number: data.number }) : null,
              !original && data.issueDate ? formatDate(data.issueDate, locale) : null,
              !original && data.totalCents !== null
                ? formatMoney(data.totalCents, locale, data.currency)
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          : undefined
      }
      aside={
        data ? (
          <>
            <StatusBadge status={data.paymentFlag} />
            <MenuButton
              label={t("invoice.actions.more")}
              icon={<Ellipsis aria-hidden />}
              items={items}
              iconOnly
            />
          </>
        ) : undefined
      }
    >
      {record.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {record.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {file.isPending && original ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("received.view.reading")}
        </p>
      ) : null}
      {data?.parseStatus === "parsed" && !original ? (
        <Banner tone="info">{t("received.view.noOriginal")}</Banner>
      ) : null}
      {file.isError ? <Banner tone="danger">{t("received.view.unreadable")}</Banner> : null}
      {loaded ? <InvoiceDocumentView invoice={loaded.invoice} /> : null}
      {data && editing ? (
        <ReceivedEditSheet record={data} open={editing} onOpenChange={setEditing} />
      ) : null}
    </Page>
  );
}
