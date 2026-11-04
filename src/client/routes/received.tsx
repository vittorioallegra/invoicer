import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Inbox, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDate, formatMoney, type UiLocale } from "../../shared/format";
import type { ReceivedInvoiceRecord } from "../../shared/received";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { StatusBadge } from "../components/ui/status-badge";
import { receivedListQuery } from "../lib/received-api";
import { useReadPending } from "../lib/use-read-pending";

function Row({ item, locale }: { item: ReceivedInvoiceRecord; locale: UiLocale }) {
  const { t } = useTranslation();
  const credit = item.documentType === "TD04";
  const title =
    item.parseStatus === "parsed"
      ? `${item.supplierName ?? "–"} · ${t("received.list.number", { number: item.number })}`
      : (item.original?.fileName ?? t("received.list.unreadTitle"));
  return (
    <li>
      <Link
        to="/received/$receivedId"
        params={{ receivedId: item.id }}
        className="flex min-h-14 items-start gap-3 px-4 py-3 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{title}</span>
          <span className="block text-sm text-muted-foreground">
            {item.parseStatus === "pending" ? (
              <span className="inline-flex items-center gap-1">
                <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
                {t("received.list.reading")}
              </span>
            ) : item.parseStatus === "failed" ? (
              t("received.list.failed")
            ) : item.issueDate ? (
              t("invoice.list.dated", { date: formatDate(item.issueDate, locale) })
            ) : null}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1">
          <span className="font-medium tabular-nums">
            {item.totalCents === null
              ? "–"
              : formatMoney(credit ? -item.totalCents : item.totalCents, locale, item.currency)}
          </span>
          <span className="flex flex-wrap justify-end gap-1">
            {item.source === "import" ? (
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {t("import.badge")}
              </span>
            ) : null}
            {item.parseStatus === "parsed" && !credit ? (
              <StatusBadge status={item.paymentFlag} />
            ) : null}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function ReceivedPage() {
  const { t, i18n } = useTranslation();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const query = useQuery(receivedListQuery);
  const { reading, remaining } = useReadPending(query.data?.received);
  const items = query.data?.received ?? [];
  return (
    <Page title={t("pages.received.title")}>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {query.isError ? (
        <Banner
          tone="danger"
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              {t("common.retry")}
            </Button>
          }
        >
          {t("common.error")}
        </Banner>
      ) : null}
      {reading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("received.list.readingCount", { count: remaining })}
        </p>
      ) : null}
      {query.data && items.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={t("pages.received.emptyTitle")}
          description={t("pages.received.emptyBody")}
        />
      ) : null}
      {items.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
          {items.map((item) => (
            <Row key={item.id} item={item} locale={locale} />
          ))}
        </ul>
      ) : null}
    </Page>
  );
}
