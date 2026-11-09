import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { romeDateTime } from "../../shared/cron";
import { formatMoney, type UiLocale } from "../../shared/format";
import {
  INVOICE_STATUS_FILTERS,
  type InvoiceFilters,
  type InvoiceRecap,
  invoiceFiltersSchema,
} from "../../shared/invoice-filters";
import { InvoiceRows } from "../components/invoice-list";
import { NewInvoiceLink } from "../components/new-invoice-link";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Disclosure } from "../components/ui/disclosure";
import { EmptyState } from "../components/ui/empty-state";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { ListSkeleton } from "../components/ui/skeleton";
import { clientsQuery } from "../lib/clients-api";
import { invoiceOverviewQuery } from "../lib/invoices-api";
import { rememberInvoiceFilters } from "../lib/list-memory";
import { numberingSeriesQuery } from "../lib/settings-api";
import { STATUS_MAP } from "../lib/status";

/** Search params of `/invoices`: the router parses numbers, the filters are strings. */
export function validateInvoicesSearch(search: Record<string, unknown>): InvoiceFilters {
  const text = Object.fromEntries(
    Object.entries(search).map(([key, value]) => [
      key,
      typeof value === "number" ? String(value) : value,
    ]),
  );
  const parsed = invoiceFiltersSchema.safeParse(text);
  if (parsed.success) return parsed.data;
  // Keep every field that is valid on its own.
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(invoiceFiltersSchema.shape) as (keyof InvoiceFilters)[]) {
    const one = invoiceFiltersSchema.shape[key].safeParse(text[key]);
    if (one.success && one.data !== undefined) kept[key] = one.data;
  }
  return kept as InvoiceFilters;
}

const route = getRouteApi("/invoices");

function useLocale(): UiLocale {
  const { i18n } = useTranslation();
  return i18n.language.startsWith("it") ? "it" : "en";
}

/** Each status filter is labelled by the status it stands for (labels live in `status.ts`). */
const FILTER_STATUS = {
  to_send: "draft",
  in_progress: "sent",
  delivered: "delivered",
  rejected: "rejected",
  paid: "paid",
  unpaid: "unpaid",
  overdue: "overdue",
} as const;

function statusLabel(t: (key: string) => string, status: keyof typeof FILTER_STATUS) {
  return t(`status.${STATUS_MAP[FILTER_STATUS[status]].label}`);
}

function Amounts({
  values,
  locale,
}: {
  values: { currency: string; cents: number }[];
  locale: UiLocale;
}) {
  return (
    <>
      {values.map(({ currency, cents }) => (
        <span key={currency} className="block text-xl font-semibold tabular-nums">
          {formatMoney(cents, locale, currency)}
        </span>
      ))}
    </>
  );
}

function Stat({
  label,
  children,
  note,
}: {
  label: string;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1">
        {children}
        {note ? <span className="block text-sm text-muted-foreground">{note}</span> : null}
      </dd>
    </div>
  );
}

/**
 * Totals of the filtered set. Amounts are summed per currency (one line each, EUR first) because
 * invoices in different currencies cannot be added up.
 */
function Recap({ recap }: { recap: InvoiceRecap }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const per = (pick: (row: InvoiceRecap["byCurrency"][number]) => number) =>
    recap.byCurrency.map((row) => ({ currency: row.currency, cents: pick(row) }));
  return (
    <section aria-label={t("invoice.recap.label")}>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("invoice.recap.count")}>
          <span className="block text-xl font-semibold tabular-nums">{recap.count}</span>
        </Stat>
        <Stat label={t("invoice.recap.invoiced")}>
          <Amounts values={per((row) => row.invoicedCents)} locale={locale} />
        </Stat>
        <Stat label={t("invoice.recap.toCollect")}>
          <Amounts values={per((row) => row.toCollectCents)} locale={locale} />
        </Stat>
        <Stat
          label={t("invoice.recap.toSend")}
          note={t("invoice.recap.toSendCount", { count: recap.toSendCount })}
        >
          <Amounts values={per((row) => row.toSendCents)} locale={locale} />
        </Stat>
      </dl>
    </section>
  );
}

export function InvoicesPage() {
  const { t } = useTranslation();
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/invoices" });
  // An invoice page's back link returns here with these filters.
  const searchKey = JSON.stringify(search);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `searchKey` stands for `search`
  useEffect(() => rememberInvoiceFilters(search), [searchKey]);
  const currentYear = romeDateTime(new Date()).date.slice(0, 4);
  const year = search.year ?? currentYear;
  const clients = useQuery(clientsQuery);
  const seriesQuery = useQuery(numberingSeriesQuery);
  const filters: InvoiceFilters = { ...search, year };
  const overview = useQuery(invoiceOverviewQuery(filters));

  const setFilter = (patch: Partial<Record<keyof InvoiceFilters, string | undefined>>) =>
    void navigate({
      search: (prev: InvoiceFilters) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const key of Object.keys(next))
          if (next[key] === undefined || next[key] === "") delete next[key];
        return next as InvoiceFilters;
      },
      replace: true,
    });

  // Phones start with the filters collapsed; wide screens with them open.
  const [open, setOpen] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(min-width: 768px)").matches
      : true,
  );
  const seriesList = seriesQuery.data?.series ?? [];
  const years = overview.data?.years ?? [Number(currentYear)];
  const clientName = clients.data?.clients.find((client) => client.id === search.client)?.name;
  const active = [
    year === "all" ? t("invoice.filters.allYears") : year,
    search.status ? statusLabel(t, search.status) : null,
    clientName ?? null,
    search.series ? seriesList.find((series) => series.id === search.series)?.name : null,
  ].filter(Boolean);
  const filtered =
    search.status !== undefined ||
    search.client !== undefined ||
    search.series !== undefined ||
    search.year !== undefined;

  return (
    <Page title={t("pages.invoices.title")} aside={<NewInvoiceLink className="md:hidden" />}>
      <Disclosure
        id="invoice-filters"
        title={t("invoice.filters.title")}
        summary={active.join(" · ")}
        open={open}
        onToggle={() => setOpen(!open)}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t("invoice.filters.year")}>
            {(control) => (
              <Select
                {...control}
                value={year}
                onChange={(event) =>
                  setFilter({
                    year: event.target.value === currentYear ? undefined : event.target.value,
                  })
                }
              >
                <option value="all">{t("invoice.filters.allYears")}</option>
                {[...new Set([...years, Number(year)].filter((y) => !Number.isNaN(y)))]
                  .sort((a, b) => b - a)
                  .map((y) => (
                    <option key={y} value={String(y)}>
                      {y}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label={t("invoice.filters.status")}>
            {(control) => (
              <Select
                {...control}
                value={search.status ?? ""}
                onChange={(event) => setFilter({ status: event.target.value || undefined })}
              >
                <option value="">{t("invoice.filters.allStatuses")}</option>
                {INVOICE_STATUS_FILTERS.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(t, status)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("invoice.filters.client")}>
            {(control) => (
              <Select
                {...control}
                value={search.client ?? ""}
                onChange={(event) => setFilter({ client: event.target.value || undefined })}
              >
                <option value="">{t("invoice.filters.allClients")}</option>
                {(clients.data?.clients ?? []).map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {seriesList.length > 1 ? (
            <Field label={t("invoice.filters.series")}>
              {(control) => (
                <Select
                  {...control}
                  value={search.series ?? ""}
                  onChange={(event) => setFilter({ series: event.target.value || undefined })}
                >
                  <option value="">{t("invoice.filters.allSeries")}</option>
                  {seriesList.map((series) => (
                    <option key={series.id} value={series.id}>
                      {series.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
        </div>
        {filtered ? (
          <Button
            variant="secondary"
            size="sm"
            className="w-fit"
            onClick={() => void navigate({ search: {}, replace: true })}
          >
            {t("invoice.filters.reset")}
          </Button>
        ) : null}
      </Disclosure>

      {overview.isPending ? (
        <ListSkeleton />
      ) : overview.isError ? (
        <Banner
          tone="danger"
          action={
            <Button size="sm" variant="secondary" onClick={() => void overview.refetch()}>
              {t("common.retry")}
            </Button>
          }
        >
          {t("common.error")}
        </Banner>
      ) : (
        <>
          <Recap recap={overview.data.recap} />
          {overview.data.invoices.length === 0 ? (
            <EmptyState
              icon={FileText}
              title={filtered ? t("pages.invoices.noMatch") : t("pages.invoices.emptyTitle")}
              {...(filtered ? {} : { description: t("pages.invoices.emptyBody") })}
            />
          ) : (
            <InvoiceRows invoices={overview.data.invoices} />
          )}
        </>
      )}
    </Page>
  );
}
