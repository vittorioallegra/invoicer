import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { formatMoney, type UiLocale } from "../../shared/format";
import type { InvoiceStatusFilter } from "../../shared/invoice-filters";
import { dashboardQuery } from "../lib/invoices-api";
import { ClientShares, CumulativeChart, MonthlyChart } from "./dashboard-charts";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

function Count({
  status,
  label,
  count,
  tone,
}: {
  status: InvoiceStatusFilter;
  label: string;
  count: number;
  tone?: "danger" | "warning";
}) {
  const hot = count > 0 && tone !== undefined;
  return (
    <Link
      to="/invoices"
      search={{ status, year: "all" }}
      className="rounded-card border border-border bg-surface p-4 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
    >
      <span className="block text-sm text-muted-foreground">{label}</span>
      <span
        className={`block text-xl font-semibold tabular-nums ${hot ? (tone === "danger" ? "text-danger" : "text-warning") : ""}`}
      >
        {count}
      </span>
    </Link>
  );
}

function Figure({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <span className="block text-sm text-muted-foreground">{label}</span>
      <span className="block text-xl font-semibold tabular-nums">{children}</span>
      {note ? <span className="block text-sm text-muted-foreground">{note}</span> : null}
    </div>
  );
}

/** Home overview: what needs attention, the trend against last year, and the year by client. */
export function DashboardStrip() {
  const { t, i18n } = useTranslation();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const query = useQuery(dashboardQuery);
  if (query.isPending) {
    return (
      <div role="status" aria-label={t("common.loading")} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder
            <Skeleton key={index} className="h-[74px]" />
          ))}
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-[150px]" />
          <Skeleton className="h-[150px]" />
        </div>
      </div>
    );
  }
  if (query.isError) {
    return (
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
    );
  }
  const stats = query.data;
  const year = stats.today.slice(0, 4);
  const currentMonth = Number(stats.today.slice(5, 7));
  return (
    <section aria-label={t("invoice.dashboard.label")} className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Count status="to_send" label={t("invoice.dashboard.toSend")} count={stats.toSendCount} />
        <Count
          status="rejected"
          label={t("invoice.dashboard.rejected")}
          count={stats.rejectedCount}
          tone="danger"
        />
        <Count
          status="overdue"
          label={t("invoice.dashboard.overdue")}
          count={stats.overdueCount}
          tone="warning"
        />
        <Figure
          label={t("invoice.dashboard.toCollect")}
          note={t("invoice.dashboard.invoiceCount", { count: stats.toCollectCount })}
        >
          {formatMoney(stats.toCollectCents, locale)}
        </Figure>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <MonthlyChart
          monthly={stats.monthly}
          year={year}
          currentMonth={currentMonth}
          locale={locale}
          label={t("invoice.dashboard.monthly")}
        />
        <CumulativeChart
          monthly={stats.monthly}
          year={year}
          currentMonth={currentMonth}
          locale={locale}
          label={t("invoice.dashboard.cumulative")}
        />
      </div>
      <ClientShares
        clients={stats.clientShares}
        locale={locale}
        label={t("invoice.dashboard.year", { year })}
        totals={stats.year}
        unknownVat={stats.unknownVatCount}
      />
    </section>
  );
}
