import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { romeDateTime } from "../../shared/cron";
import { formatInvoiceNumber } from "../../shared/numbering";
import { type FicSummary, missingSeries, parseFicSummary, yearRange } from "../import/fic-summary";
import { runSummaryImport, type SummaryItem, type SummaryProgress } from "../import/summary-run";
import { readXls } from "../import/xls";
import { useOnline } from "../lib/online";
import { numberingSeriesQuery } from "../lib/settings-api";
import { ImportResult } from "./import-result";
import { type RowChoice, type RowChoices, rowKey, SummaryReview } from "./summary-review";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Disclosure } from "./ui/disclosure";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Import of a Fatture in Cloud account summary (.xls): the owner picks the file, the browser reads
 * it, and a preview says what was found (issued and received invoices, years, the numbering
 * series that would be created, rows that cannot be read) before anything is stored.
 */
export function SummaryImport() {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const seriesQuery = useQuery(numberingSeriesQuery);
  const [summary, setSummary] = useState<FicSummary | null>(null);
  const [reading, setReading] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const [markPaid, setMarkPaid] = useState(true);
  const [choices, setChoices] = useState<RowChoices>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [progress, setProgress] = useState<SummaryProgress | null>(null);
  const [items, setItems] = useState<SummaryItem[] | null>(null);

  const pick = async (file: File | undefined) => {
    setSummary(null);
    setChoices({});
    setUnreadable(false);
    if (!file) return;
    setReading(true);
    // Let the page paint "reading" before the parsing blocks the thread.
    await tick();
    try {
      const parsed = parseFicSummary(readXls(new Uint8Array(await file.arrayBuffer())));
      if (parsed) setSummary(parsed);
      else setUnreadable(true);
    } catch {
      setUnreadable(true);
    } finally {
      setReading(false);
    }
  };

  const today = romeDateTime(new Date()).date;
  // An invoice dated after today is not issued yet: it starts left out unless the owner ticks it.
  const included = (kind: "issued" | "received", line: number, date: string) =>
    choices[rowKey(kind, line)]?.include ?? date <= today;
  const paidFor = (kind: "issued" | "received", line: number) =>
    choices[rowKey(kind, line)]?.paid ?? markPaid;
  const selected: FicSummary | null = summary && {
    ...summary,
    issued: summary.issued.filter((item) => included("issued", item.line, item.row.date)),
    received: summary.received.filter((item) =>
      included("received", item.line, item.row.issueDate),
    ),
  };
  const leftOut = summary
    ? summary.issued.length +
      summary.received.length -
      (selected?.issued.length ?? 0) -
      (selected?.received.length ?? 0)
    : 0;
  const series = selected
    ? missingSeries(
        selected.issued.map((item) => item.row.number),
        seriesQuery.data?.series ?? [],
      )
    : [];
  const years = selected ? yearRange(selected) : null;
  const count = (selected?.issued.length ?? 0) + (selected?.received.length ?? 0);
  const change = (key: string, next: RowChoice) =>
    setChoices((current) => ({ ...current, [key]: { ...current[key], ...next } }));

  const fieldText = (field: string) => t(`import.summary.fields.${field}`);
  const run = useMutation({
    mutationFn: async () => {
      if (!selected) return [];
      return runSummaryImport(selected, {
        markPaid,
        paidFor,
        series,
        label: (kind, number, date, name) =>
          t(`import.summary.label.${kind}`, { number, date, name }),
        invalidLabel: (row) =>
          t("import.summary.invalidLabel", {
            line: row.line,
            kind: t(`import.summary.kind.${row.kind}`),
          }),
        invalidDetail: (row) => t("import.summary.invalidDetail", { field: fieldText(row.field) }),
        onProgress: setProgress,
      });
    },
    onSuccess: async (done) => {
      setItems(done);
      setSummary(null);
      if (input.current) input.current.value = "";
      for (const key of ["invoices", "received", "next-number", "numbering-series"]) {
        await queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    onSettled: () => setProgress(null),
  });

  if (items) {
    const kinds = new WeakMap<object, "issued" | "received">(
      items.map((item) => [item, item.kind]),
    );
    return (
      <ImportResult
        results={items}
        onAgain={() => setItems(null)}
        linkFor={(item) =>
          item.id ? (
            <Link
              {...(kinds.get(item) === "received"
                ? { to: "/received/$receivedId", params: { receivedId: item.id } }
                : { to: "/invoices/$invoiceId", params: { invoiceId: item.id } })}
              className="text-sm text-primary underline underline-offset-2"
            >
              {t("import.result.open")}
            </Link>
          ) : null
        }
      />
    );
  }

  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (summary && count > 0) run.mutate();
      }}
    >
      <p className="text-sm text-muted-foreground">{t("import.summary.intro")}</p>
      <div className="flex flex-col gap-2">
        <label htmlFor="import-summary-file" className="text-sm font-medium">
          {t("import.summary.file")}
        </label>
        <input
          id="import-summary-file"
          ref={input}
          type="file"
          accept=".xls,application/vnd.ms-excel"
          disabled={run.isPending || reading}
          onChange={(event) => void pick(event.target.files?.[0])}
          className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-control file:border file:border-border file:bg-surface file:px-4 file:py-2 file:text-sm file:font-medium hover:file:bg-muted"
        />
      </div>
      {reading ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          {t("import.summary.reading")}
        </p>
      ) : null}
      {unreadable ? <Banner tone="danger">{t("import.summary.unreadable")}</Banner> : null}
      {summary ? (
        <section aria-labelledby="summary-preview" className="flex flex-col gap-3">
          <h2 id="summary-preview" className="text-base font-semibold">
            {t("import.summary.found")}
          </h2>
          {count === 0 ? (
            <Banner tone="warning">{t("import.summary.nothing")}</Banner>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              <li>{t("import.summary.issuedCount", { count: selected?.issued.length ?? 0 })}</li>
              <li>
                {t("import.summary.receivedCount", { count: selected?.received.length ?? 0 })}
              </li>
              {years ? (
                <li>
                  {years.from === years.to
                    ? t("import.summary.year", { year: years.from })
                    : t("import.summary.years", { from: years.from, to: years.to })}
                </li>
              ) : null}
            </ul>
          )}
          {leftOut > 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("import.summary.leftOut", { count: leftOut })}
            </p>
          ) : null}
          {series.length > 0 ? (
            <div className="text-sm">
              <p className="font-medium">{t("import.summary.series")}</p>
              <ul className="list-disc pl-5 text-muted-foreground">
                {series.map((item) => (
                  <li key={`${item.prefix}|${item.suffix}`}>
                    {t("import.summary.seriesRow", {
                      name: item.name,
                      example: formatInvoiceNumber(item, 1),
                    })}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {summary.invalid.length > 0 ? (
            <div className="text-sm">
              <p className="font-medium">
                {t("import.summary.invalidCount", { count: summary.invalid.length })}
              </p>
              <ul className="list-disc pl-5 text-muted-foreground">
                {summary.invalid.map((row) => (
                  <li key={`${row.kind}-${row.line}`}>
                    {t("import.summary.invalidLabel", {
                      line: row.line,
                      kind: t(`import.summary.kind.${row.kind}`),
                    })}
                    : {fieldText(row.field)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={markPaid}
              onChange={(event) => setMarkPaid(event.target.checked)}
              disabled={run.isPending}
              className="mt-1 size-4"
            />
            <span>
              <span className="block font-medium">{t("import.issued.markPaid")}</span>
              <span className="block text-muted-foreground">
                {t("import.summary.markPaidHint")}
              </span>
            </span>
          </label>
          <Disclosure
            id="summary-review"
            title={t("import.summary.review")}
            summary={t("import.summary.reviewSummary")}
            open={reviewOpen}
            onToggle={() => setReviewOpen((open) => !open)}
          >
            <SummaryReview
              summary={summary}
              today={today}
              choices={choices}
              markPaid={markPaid}
              disabled={run.isPending}
              onChange={change}
            />
          </Disclosure>
        </section>
      ) : null}
      {run.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {progress ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          {t("import.running", {
            done: Math.min(progress.done + 1, progress.total),
            total: progress.total,
          })}
        </p>
      ) : null}
      <Button
        type="submit"
        className="w-fit"
        disabled={!online || !summary || count === 0 || run.isPending || seriesQuery.isPending}
      >
        {t("import.start")}
      </Button>
    </form>
  );
}
