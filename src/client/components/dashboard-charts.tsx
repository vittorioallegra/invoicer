import { useTranslation } from "react-i18next";
import { formatMoney, type UiLocale } from "../../shared/format";
import type { ClientShare, MonthlyPoint, PeriodTotal } from "../../shared/invoice-filters";

const W = 600;
const H = 200;
const LEFT = 44;
const TOP = 10;
const BOTTOM = 24;
const PLOT_H = H - TOP - BOTTOM;
const PLOT_W = W - LEFT - 4;

/** A round upper bound for the axis so the three grid lines carry readable values. */
function niceMax(value: number): number {
  if (value <= 0) return 100_00;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

function useMonthNames(locale: UiLocale): string[] {
  const format = new Intl.DateTimeFormat(locale, { month: "narrow", timeZone: "UTC" });
  return Array.from({ length: 12 }, (_, index) =>
    format.format(new Date(Date.UTC(2026, index, 1))),
  );
}

function compact(cents: number, locale: UiLocale): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(
    cents / 100,
  );
}

function Legend({ year }: { year: string }) {
  return (
    <ul className="flex gap-4 text-sm text-muted-foreground">
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="size-2.5 rounded-sm bg-primary" />
        {year}
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="size-2.5 rounded-sm bg-muted-foreground/40" />
        {Number(year) - 1}
      </li>
    </ul>
  );
}

function Axis({ max, locale }: { max: number; locale: UiLocale }) {
  return (
    <>
      {[0, 1, 2, 3].map((step) => {
        const y = TOP + PLOT_H - (PLOT_H * step) / 3;
        return (
          <g key={step}>
            <line x1={LEFT} x2={W - 4} y1={y} y2={y} className="stroke-border" strokeWidth={1} />
            <text
              x={LEFT - 6}
              y={y + 3}
              textAnchor="end"
              className="fill-muted-foreground"
              fontSize={10}
            >
              {compact((max * step) / 3, locale)}
            </text>
          </g>
        );
      })}
    </>
  );
}

function MonthLabels({ locale }: { locale: UiLocale }) {
  const names = useMonthNames(locale);
  return (
    <>
      {names.map((name, index) => (
        <text
          // biome-ignore lint/suspicious/noArrayIndexKey: the twelve months never reorder
          key={index}
          x={LEFT + (PLOT_W * (index + 0.5)) / 12}
          y={H - 8}
          textAnchor="middle"
          className="fill-muted-foreground"
          fontSize={10}
        >
          {name}
        </text>
      ))}
    </>
  );
}

/** Invoiced per month of this year (bars) beside the same month of the previous year. */
export function MonthlyChart({
  monthly,
  year,
  currentMonth,
  locale,
  label,
}: {
  monthly: MonthlyPoint[];
  year: string;
  /** 1 to 12: later months of this year have no bar yet. */
  currentMonth: number;
  locale: UiLocale;
  label: string;
}) {
  const max = niceMax(Math.max(...monthly.flatMap((m) => [m.currentCents, m.previousCents])));
  const slot = PLOT_W / 12;
  const bar = Math.min(16, slot / 2 - 2);
  const height = (cents: number) => (Math.max(cents, 0) / max) * PLOT_H;
  return (
    <figure className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Legend year={year} />
      </figcaption>
      <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
        <title>{label}</title>
        <Axis max={max} locale={locale} />
        {monthly.map((point) => {
          const center = LEFT + slot * (point.month - 0.5);
          const base = TOP + PLOT_H;
          const previous = height(point.previousCents);
          const current = height(point.currentCents);
          return (
            <g key={point.month}>
              <rect
                x={center - bar - 1}
                y={base - previous}
                width={bar}
                height={previous}
                rx={2}
                className="fill-muted-foreground/40"
              >
                <title>{`${Number(year) - 1}: ${formatMoney(point.previousCents, locale)}`}</title>
              </rect>
              {point.month <= currentMonth ? (
                <rect
                  x={center + 1}
                  y={base - current}
                  width={bar}
                  height={current}
                  rx={2}
                  className="fill-primary"
                >
                  <title>{`${year}: ${formatMoney(point.currentCents, locale)}`}</title>
                </rect>
              ) : null}
            </g>
          );
        })}
        <MonthLabels locale={locale} />
      </svg>
    </figure>
  );
}

/** Running total through the year against the previous year's, so the pace is visible. */
export function CumulativeChart({
  monthly,
  year,
  currentMonth,
  locale,
  label,
}: {
  monthly: MonthlyPoint[];
  year: string;
  currentMonth: number;
  locale: UiLocale;
  label: string;
}) {
  const running = (pick: (point: MonthlyPoint) => number, upTo: number) => {
    let sum = 0;
    return monthly.slice(0, upTo).map((point) => {
      sum += pick(point);
      return sum;
    });
  };
  const current = running((p) => p.currentCents, currentMonth);
  const previous = running((p) => p.previousCents, 12);
  const max = niceMax(Math.max(...current, ...previous));
  const slot = PLOT_W / 12;
  const x = (index: number) => LEFT + slot * (index + 0.5);
  const y = (cents: number) => TOP + PLOT_H - (Math.max(cents, 0) / max) * PLOT_H;
  const path = (values: number[]) =>
    values.map((cents, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(cents)}`).join(" ");
  const last = current.length - 1;
  return (
    <figure className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Legend year={year} />
      </figcaption>
      <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
        <title>{label}</title>
        <Axis max={max} locale={locale} />
        <path
          d={path(previous)}
          fill="none"
          className="stroke-muted-foreground/50"
          strokeWidth={2}
          strokeDasharray="4 3"
        />
        <path d={path(current)} fill="none" className="stroke-primary" strokeWidth={2.5} />
        {last >= 0 ? (
          <circle cx={x(last)} cy={y(current[last] ?? 0)} r={4} className="fill-primary" />
        ) : null}
        <MonthLabels locale={locale} />
      </svg>
    </figure>
  );
}

/** Horizontal bars: each client's share of this year's invoicing, biggest first. */
export function ClientShares({
  clients,
  totals,
  unknownVat,
  locale,
  label,
}: {
  clients: ClientShare[];
  /** The year's totals per currency (EUR first), shown under the list. */
  totals: PeriodTotal[];
  /** Invoices of the year without lines: their VAT is counted as 0. */
  unknownVat: number;
  locale: UiLocale;
  label: string;
}) {
  const { t } = useTranslation();
  const top = Math.max(...clients.map((client) => client.invoicedCents), 1);
  const total = clients.reduce((sum, client) => sum + client.invoicedCents, 0);
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
    >
      <h3 className="text-sm font-medium">{label}</h3>
      {clients.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("invoice.dashboard.noClients")}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {clients.map((client) => (
            <li key={client.name} className="flex flex-col gap-1">
              <span className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{client.name || "—"}</span>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(client.invoicedCents, locale)}
                  <span className="ml-2 text-muted-foreground">
                    {Math.round((client.invoicedCents / total) * 100)}%
                  </span>
                </span>
              </span>
              <svg aria-hidden width="100%" height={6} className="block">
                <rect width="100%" height={6} rx={3} className="fill-muted" />
                <rect
                  width={`${(client.invoicedCents / top) * 100}%`}
                  height={6}
                  rx={3}
                  className="fill-primary"
                />
              </svg>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-col gap-3 border-t border-border pt-3 text-right">
        {totals.map((row) => {
          const money = (cents: number) => formatMoney(cents, locale, row.currency);
          return (
            <div key={row.currency}>
              <span className="block text-xl font-semibold tabular-nums">
                {money(row.invoicedCents)}
              </span>
              <span className="block text-sm text-muted-foreground">
                {t("invoice.dashboard.net", {
                  amount: money(row.invoicedCents - row.vatCents - row.contributionCents),
                })}
              </span>
              {row.contributionCents !== 0 ? (
                <span className="block text-sm text-muted-foreground">
                  {t("invoice.dashboard.contribution", { amount: money(row.contributionCents) })}
                </span>
              ) : null}
              <span className="block text-sm text-muted-foreground">
                {t("invoice.dashboard.vat", { amount: money(row.vatCents) })}
              </span>
            </div>
          );
        })}
        {unknownVat > 0 ? (
          <span className="block text-sm text-muted-foreground">
            {t("invoice.dashboard.unknownVat", { count: unknownVat })}
          </span>
        ) : null}
      </div>
    </section>
  );
}
