import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { Inbox, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { romeDateTime } from "../../shared/cron";
import { formatDate, formatMoney, type UiLocale } from "../../shared/format";
import type { ReceivedInvoiceRecord } from "../../shared/received";
import {
  filterReceived,
  type ReceivedFilters,
  receivedFiltersSchema,
  receivedRecap,
  receivedSuppliers,
  receivedYears,
} from "../../shared/received-filters";
import { Page } from "../components/page";
import { Amounts, Stat } from "../components/recap-stat";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Disclosure } from "../components/ui/disclosure";
import { EmptyState } from "../components/ui/empty-state";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { ListSkeleton } from "../components/ui/skeleton";
import { CreditNoteBadge, ImportedBadge, StatusBadge } from "../components/ui/status-badge";
import { rememberReceivedFilters } from "../lib/list-memory";
import { receivedListQuery } from "../lib/received-api";
import { useReadPending } from "../lib/use-read-pending";

/** Search params of `/received`: the router parses numbers, the filters are strings. */
export function validateReceivedSearch(search: Record<string, unknown>): ReceivedFilters {
  const text = Object.fromEntries(
    Object.entries(search).map(([key, value]) => [
      key,
      typeof value === "number" ? String(value) : value,
    ]),
  );
  const parsed = receivedFiltersSchema.safeParse(text);
  if (parsed.success) return parsed.data;
  // Keep every field that is valid on its own.
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(receivedFiltersSchema.shape) as (keyof ReceivedFilters)[]) {
    const one = receivedFiltersSchema.shape[key].safeParse(text[key]);
    if (one.success && one.data !== undefined) kept[key] = one.data;
  }
  return kept as ReceivedFilters;
}

const route = getRouteApi("/received");

function Row({ item, locale }: { item: ReceivedInvoiceRecord; locale: UiLocale }) {
  const { t } = useTranslation();
  const credit = item.documentType === "TD04";
  const parsed = item.parseStatus === "parsed";
  const title = parsed
    ? (item.supplierName ?? "–")
    : (item.original?.fileName ?? t("received.list.unreadTitle"));
  const subtitle = parsed
    ? [
        item.number ? t("received.list.number", { number: item.number }) : null,
        item.issueDate ? formatDate(item.issueDate, locale) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
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
            ) : (
              subtitle
            )}
          </span>
          {item.source === "import" || parsed ? (
            <span className="mt-1 flex flex-wrap gap-1">
              {item.source === "import" ? <ImportedBadge /> : null}
              {parsed && credit ? <CreditNoteBadge /> : null}
              {parsed && !credit ? <StatusBadge status={item.paymentFlag} /> : null}
            </span>
          ) : null}
        </span>
        <span className="font-medium tabular-nums">
          {item.totalCents === null
            ? "–"
            : formatMoney(credit ? -item.totalCents : item.totalCents, locale, item.currency)}
        </span>
      </Link>
    </li>
  );
}

export function ReceivedPage() {
  const { t, i18n } = useTranslation();
  const locale: UiLocale = i18n.language.startsWith("it") ? "it" : "en";
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/received" });
  // A received invoice page's back link returns here with these filters.
  const searchKey = JSON.stringify(search);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `searchKey` stands for `search`
  useEffect(() => rememberReceivedFilters(search), [searchKey]);
  const query = useQuery(receivedListQuery);
  const { reading, remaining } = useReadPending(query.data?.received);
  const all = query.data?.received ?? [];
  const currentYear = romeDateTime(new Date()).date.slice(0, 4);
  const year = search.year ?? "all";
  const items = filterReceived(all, search);
  const recap = receivedRecap(items);
  const years = receivedYears(all, currentYear);
  const suppliers = receivedSuppliers(all);
  const supplierName = suppliers.find((supplier) => supplier.key === search.supplier)?.name;
  const filtered = search.year !== undefined || search.supplier !== undefined;
  // Phones start with the filters collapsed; wide screens with them open.
  const [open, setOpen] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(min-width: 768px)").matches
      : true,
  );
  const setFilter = (patch: Partial<Record<keyof ReceivedFilters, string | undefined>>) =>
    void navigate({
      search: (prev: ReceivedFilters) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const key of Object.keys(next))
          if (next[key] === undefined || next[key] === "") delete next[key];
        return next as ReceivedFilters;
      },
      replace: true,
    });
  const per = (pick: (row: (typeof recap.byCurrency)[number]) => number) =>
    recap.byCurrency.map((row) => ({ currency: row.currency, cents: pick(row) }));
  const active = [
    year === "all" ? t("received.filters.allYears") : year,
    supplierName ?? null,
  ].filter(Boolean);
  return (
    <Page title={t("pages.received.title")}>
      {all.length > 0 ? (
        <Disclosure
          id="received-filters"
          title={t("received.filters.title")}
          summary={active.join(" · ")}
          open={open}
          onToggle={() => setOpen(!open)}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("received.filters.year")}>
              {(control) => (
                <Select
                  {...control}
                  value={year}
                  onChange={(event) =>
                    setFilter({
                      year: event.target.value === "all" ? undefined : event.target.value,
                    })
                  }
                >
                  <option value="all">{t("received.filters.allYears")}</option>
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
            <Field label={t("received.filters.supplier")}>
              {(control) => (
                <Select
                  {...control}
                  value={search.supplier ?? ""}
                  onChange={(event) => setFilter({ supplier: event.target.value || undefined })}
                >
                  <option value="">{t("received.filters.allSuppliers")}</option>
                  {suppliers.map((supplier) => (
                    <option key={supplier.key} value={supplier.key}>
                      {supplier.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {filtered ? (
            <Button
              variant="secondary"
              size="sm"
              className="w-fit"
              onClick={() => void navigate({ search: {}, replace: true })}
            >
              {t("received.filters.reset")}
            </Button>
          ) : null}
        </Disclosure>
      ) : null}
      {query.isPending ? <ListSkeleton /> : null}
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
      {query.data && all.length > 0 ? (
        <section aria-label={t("received.recap.label")}>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Stat label={t("received.recap.count")}>
              <span className="block text-xl font-semibold tabular-nums">{recap.count}</span>
            </Stat>
            <Stat label={t("received.recap.received")}>
              <Amounts values={per((row) => row.receivedCents)} locale={locale} />
            </Stat>
            <Stat label={t("received.recap.toPay")}>
              <Amounts values={per((row) => row.toPayCents)} locale={locale} />
            </Stat>
          </dl>
        </section>
      ) : null}
      {query.data && items.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={
            filtered || all.length > 0
              ? t("pages.received.noMatch")
              : t("pages.received.emptyTitle")
          }
          {...(filtered || all.length > 0 ? {} : { description: t("pages.received.emptyBody") })}
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
