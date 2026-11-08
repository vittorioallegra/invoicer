import { useTranslation } from "react-i18next";
import { formatMoney, resolveLocale } from "../../shared/format";
import type { FicSummary } from "../import/fic-summary";
import { cn } from "../lib/utils";

/** What the owner changed for one invoice of the file; a missing field keeps the default. */
export interface RowChoice {
  include?: boolean;
  paid?: boolean;
}
export type RowChoices = Record<string, RowChoice>;
export const rowKey = (kind: "issued" | "received", line: number) => `${kind}:${line}`;

interface Entry {
  kind: "issued" | "received";
  line: number;
  number: string;
  date: string;
  name: string;
  totalCents: number;
  currency: string;
}

function entries(summary: FicSummary): Entry[] {
  const issued = summary.issued.map(({ line, row }) => ({
    kind: "issued" as const,
    line,
    number: row.number,
    date: row.date,
    name: row.customer.name,
    totalCents: row.totalCents,
    currency: row.currency,
  }));
  const received = summary.received.map(({ line, row }) => ({
    kind: "received" as const,
    line,
    number: row.number,
    date: row.issueDate,
    name: row.supplierName,
    totalCents: row.totalCents ?? 0,
    currency: row.currency,
  }));
  return [...issued, ...received];
}

/**
 * Every invoice of the file with a box to leave it out and a box for "paid". The newest come first,
 * because those are the ones that are still open. An issued invoice dated after today is not
 * issued yet: it is created as an unsent invoice (ticked, never paid). A received one dated after
 * today starts unticked.
 */
export function SummaryReview({
  summary,
  today,
  choices,
  markPaid,
  disabled,
  onChange,
}: {
  summary: FicSummary;
  today: string;
  choices: RowChoices;
  markPaid: boolean;
  disabled: boolean;
  onChange: (key: string, change: RowChoice) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale([i18n.language]);
  const sorted = entries(summary).sort(
    (a, b) => b.date.localeCompare(a.date) || a.number.localeCompare(b.number),
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t("import.summary.reviewHint")}</p>
      <ul className="flex max-h-[28rem] flex-col divide-y divide-border overflow-y-auto rounded-control border border-border">
        {sorted.map((entry) => {
          const key = rowKey(entry.kind, entry.line);
          const future = entry.date > today;
          const toSend = future && entry.kind === "issued";
          const include = choices[key]?.include ?? !(future && !toSend);
          const paid = toSend ? false : (choices[key]?.paid ?? markPaid);
          const label = t(`import.summary.label.${entry.kind}`, {
            number: entry.number,
            date: entry.date,
            name: entry.name,
          });
          return (
            <li key={key} className={cn("flex flex-col gap-2 px-3 py-2", !include && "opacity-60")}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{label}</span>
                  {future ? (
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {t(toSend ? "import.summary.willBeToSend" : "import.summary.notIssuedYet")}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatMoney(entry.totalCents, locale, entry.currency)}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <label className="flex min-h-8 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={include}
                    disabled={disabled}
                    aria-label={t("import.summary.rowImportLabel", { row: label })}
                    onChange={(event) => onChange(key, { include: event.target.checked })}
                    className="size-4"
                  />
                  {t("import.summary.rowImport")}
                </label>
                {toSend ? null : (
                  <label className="flex min-h-8 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={paid}
                      disabled={disabled || !include}
                      aria-label={t("import.summary.rowPaidLabel", { row: label })}
                      onChange={(event) => onChange(key, { paid: event.target.checked })}
                      className="size-4"
                    />
                    {t("import.summary.rowPaid")}
                  </label>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
