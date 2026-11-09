import type { ReactNode } from "react";
import { formatMoney, type UiLocale } from "../../shared/format";

/** One amount per currency, one line each (invoices in different currencies cannot be added up). */
export function Amounts({
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

export function Stat({
  label,
  children,
  note,
}: {
  label: string;
  children: ReactNode;
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
