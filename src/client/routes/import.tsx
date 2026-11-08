import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { romeDateTime } from "../../shared/cron";
import { formatInvoiceNumber } from "../../shared/numbering";
import { ClientsImport } from "../components/clients-import";
import { ImportResult } from "../components/import-result";
import { Page } from "../components/page";
import { SummaryImport } from "../components/summary-import";
import { Banner } from "../components/ui/banner";
import { Button, buttonVariants } from "../components/ui/button";
import {
  type ImportOutcome,
  type ImportProgress,
  type PickedFile,
  runInvoiceImport,
} from "../import/run";
import { SETTINGS_BACK } from "../lib/back-links";
import { useOnline } from "../lib/online";
import { numberingSeriesQuery, profileQuery } from "../lib/settings-api";
import { cn } from "../lib/utils";

export const IMPORT_KINDS = ["invoices", "clients", "summary"] as const;
export type ImportPageKind = (typeof IMPORT_KINDS)[number];

/**
 * Search params of `/import`: which import is shown (default: invoices). The former `issued` and
 * `received` tabs were merged into `invoices`, so old links keep working.
 */
export function validateImportSearch(search: Record<string, unknown>): { kind?: ImportPageKind } {
  if (search.kind === "issued" || search.kind === "received") return { kind: "invoices" };
  const kind = IMPORT_KINDS.find((value) => value === search.kind);
  return kind ? { kind } : {};
}

function FilePicker({
  accept,
  files,
  onChange,
  disabled,
}: {
  accept: string;
  files: File[];
  onChange: (files: File[]) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="import-files" className="text-sm font-medium">
        {t("import.files")}
      </label>
      <input
        id="import-files"
        ref={input}
        type="file"
        multiple
        accept={accept}
        disabled={disabled}
        onChange={(event) => onChange([...(event.target.files ?? [])])}
        className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-control file:border file:border-border file:bg-surface file:px-4 file:py-2 file:text-sm file:font-medium hover:file:bg-muted"
      />
      {files.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("import.selected", { count: files.length })}
        </p>
      ) : null}
    </div>
  );
}

function InvoiceImport() {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const profile = useQuery(profileQuery);
  const seriesQuery = useQuery(numberingSeriesQuery);
  const [files, setFiles] = useState<File[]>([]);
  const [markPaid, setMarkPaid] = useState(true);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const own = profile.data?.profile;
  const ownVat = own?.vatNumber ? `${own.country}${own.vatNumber}` : null;

  const run = useMutation({
    mutationFn: async () => {
      if (!ownVat) throw new Error("no_vat");
      const picked: PickedFile[] = files.map((file) => ({
        name: file.name,
        read: async () => new Uint8Array(await file.arrayBuffer()),
      }));
      return runInvoiceImport(picked, {
        markPaid,
        ownVat,
        ownTaxCode: own?.taxCode || null,
        today: romeDateTime(new Date()).date,
        series: seriesQuery.data?.series ?? [],
        label: (kind, number, date, name) =>
          t(`import.summary.label.${kind}`, { number, date, name }),
        onProgress: setProgress,
      });
    },
    onSuccess: async (result) => {
      setOutcome(result);
      setFiles([]);
      for (const key of ["invoices", "received", "next-number", "numbering-series"]) {
        await queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    onSettled: () => setProgress(null),
  });

  if (outcome) {
    return (
      <ImportResult
        results={outcome.items}
        onAgain={() => setOutcome(null)}
        notes={
          outcome.createdSeries.length > 0 ? (
            <div className="rounded-card border border-border bg-surface px-4 py-3 text-sm">
              <p className="font-medium">{t("import.seriesCreated")}</p>
              <ul className="list-disc pl-5 text-muted-foreground">
                {outcome.createdSeries.map((item) => (
                  <li key={`${item.prefix}|${item.suffix}`}>
                    {t("import.summary.seriesRow", {
                      name: item.name,
                      example: formatInvoiceNumber(item, 1),
                    })}
                  </li>
                ))}
              </ul>
            </div>
          ) : null
        }
        linkFor={(item) =>
          item.id ? (
            <Link
              {...(item.kind === "received"
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

  const missingVat = profile.isSuccess && !ownVat;
  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (files.length > 0 && ownVat) run.mutate();
      }}
    >
      <p className="text-sm text-muted-foreground">{t("import.invoices.intro")}</p>
      <FilePicker
        accept=".xml,.p7m,.zip,application/xml,text/xml,application/zip,application/pkcs7-mime"
        files={files}
        onChange={setFiles}
        disabled={run.isPending}
      />
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={markPaid}
          onChange={(event) => setMarkPaid(event.target.checked)}
          disabled={run.isPending}
          className="mt-1 size-4"
        />
        <span>
          <span className="block font-medium">{t("import.invoices.markPaid")}</span>
          <span className="block text-muted-foreground">{t("import.invoices.markPaidHint")}</span>
        </span>
      </label>
      {missingVat ? (
        <Banner tone="warning">
          {t("import.noProfile")}{" "}
          <Link to="/settings/company" className="underline underline-offset-2">
            {t("import.noProfileLink")}
          </Link>
        </Banner>
      ) : null}
      {run.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {progress ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          <span className="min-w-0 break-words">
            {t("import.running", {
              done: Math.min(progress.done + 1, progress.total),
              total: progress.total,
            })}
            {progress.label ? ` · ${progress.label}` : ""}
          </span>
        </p>
      ) : null}
      <Button
        type="submit"
        className="w-fit"
        disabled={
          !online ||
          files.length === 0 ||
          run.isPending ||
          profile.isPending ||
          seriesQuery.isPending ||
          !ownVat
        }
      >
        {t("import.start")}
      </Button>
    </form>
  );
}

export function ImportPage() {
  const { t } = useTranslation();
  // `strict: false` hands back the raw search of the URL, so validate it again here.
  const search = validateImportSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const kind = search.kind ?? "invoices";
  return (
    <Page title={t("import.title")} back={SETTINGS_BACK}>
      <nav aria-label={t("import.title")} className="flex flex-wrap gap-2">
        {IMPORT_KINDS.map((value) => (
          <Link
            key={value}
            to="/import"
            search={{ kind: value }}
            aria-current={value === kind ? "page" : undefined}
            className={cn(
              buttonVariants({ variant: value === kind ? "default" : "secondary", size: "sm" }),
            )}
          >
            {t(`import.kinds.${value}`)}
          </Link>
        ))}
      </nav>
      {kind === "clients" ? (
        <ClientsImport />
      ) : kind === "summary" ? (
        <SummaryImport />
      ) : (
        <InvoiceImport />
      )}
    </Page>
  );
}
