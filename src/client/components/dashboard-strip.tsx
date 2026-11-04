import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { formatMoney, type UiLocale } from "../../shared/format";
import type { InvoiceStatusFilter, PeriodTotal } from "../../shared/invoice-filters";
import { dashboardQuery } from "../lib/invoices-api";
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

function Total({
  label,
  totals,
  locale,
}: {
  label: string;
  totals: PeriodTotal[];
  locale: UiLocale;
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <span className="block text-sm text-muted-foreground">{label}</span>
      {totals.map(({ currency, invoicedCents }) => (
        <span key={currency} className="block text-xl font-semibold tabular-nums">
          {formatMoney(invoicedCents, locale, currency)}
        </span>
      ))}
    </div>
  );
}

/** Home top strip: counts that need attention, then the year's and month's invoiced totals. */
export function DashboardStrip() {
  const { t, i18n } = useTranslation();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const query = useQuery(dashboardQuery);
  if (query.isPending) {
    return (
      <div
        role="status"
        aria-label={t("common.loading")}
        className="grid grid-cols-2 gap-3 lg:grid-cols-5"
      >
        {Array.from({ length: 5 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder
          <Skeleton key={index} className="h-[74px]" />
        ))}
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
  return (
    <section
      aria-label={t("invoice.dashboard.label")}
      className="grid grid-cols-2 gap-3 lg:grid-cols-5"
    >
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
      <Total
        label={t("invoice.dashboard.year", { year: stats.today.slice(0, 4) })}
        totals={stats.year}
        locale={locale}
      />
      <Total
        label={t("invoice.dashboard.month", {
          month: new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(
            new Date(`${stats.today.slice(0, 7)}-01T00:00:00Z`),
          ),
        })}
        totals={stats.month}
        locale={locale}
      />
    </section>
  );
}
