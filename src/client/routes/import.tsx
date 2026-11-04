import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImportItemResult } from "../../shared/import";
import { ClientsImport } from "../components/clients-import";
import { ImportResult } from "../components/import-result";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button, buttonVariants } from "../components/ui/button";
import {
  type ImportKind,
  type ImportProgress,
  type PickedFile,
  runInvoiceImport,
} from "../import/run";
import { IMPORT_ORIGINS, type ImportOrigin, importBackLink } from "../lib/back-links";
import { useOnline } from "../lib/online";
import { profileQuery } from "../lib/settings-api";
import { cn } from "../lib/utils";

export const IMPORT_KINDS = ["received", "issued", "clients"] as const;
export type ImportPageKind = (typeof IMPORT_KINDS)[number];

/**
 * Search params of `/import`: which import is shown (default: received invoices) and the page it
 * was opened from, which the back link returns to (default: Settings). Unknown values are dropped.
 */
export function validateImportSearch(search: Record<string, unknown>): {
  kind?: ImportPageKind;
  from?: ImportOrigin;
} {
  const kind = IMPORT_KINDS.find((value) => value === search.kind);
  const from = IMPORT_ORIGINS.find((value) => value === search.from);
  return { ...(kind ? { kind } : {}), ...(from ? { from } : {}) };
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

function InvoiceImport({ kind }: { kind: ImportKind }) {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const profile = useQuery(profileQuery);
  const [files, setFiles] = useState<File[]>([]);
  const [markPaid, setMarkPaid] = useState(true);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [results, setResults] = useState<ImportItemResult[] | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      const own = profile.data?.profile;
      const picked: PickedFile[] = files.map((file) => ({
        name: file.name,
        read: async () => new Uint8Array(await file.arrayBuffer()),
      }));
      return runInvoiceImport(picked, {
        kind,
        markPaid,
        ownVat: own ? `${own.country}${own.vatNumber}` : null,
        onProgress: setProgress,
      });
    },
    onSuccess: async (items) => {
      setResults(items);
      setFiles([]);
      await queryClient.invalidateQueries({
        queryKey: [kind === "received" ? "received" : "invoices"],
      });
      await queryClient.invalidateQueries({ queryKey: ["next-number"] });
    },
    onSettled: () => setProgress(null),
  });

  if (results) {
    return (
      <ImportResult
        results={results}
        onAgain={() => setResults(null)}
        linkFor={(item) =>
          item.id ? (
            <Link
              {...(kind === "received"
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
        if (files.length > 0) run.mutate();
      }}
    >
      <p className="text-sm text-muted-foreground">{t(`import.${kind}.intro`)}</p>
      <FilePicker
        accept=".xml,.p7m,.zip,application/xml,text/xml,application/zip,application/pkcs7-mime"
        files={files}
        onChange={setFiles}
        disabled={run.isPending}
      />
      {kind === "issued" ? (
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
            <span className="block text-muted-foreground">{t("import.issued.markPaidHint")}</span>
          </span>
        </label>
      ) : null}
      {profile.isSuccess && !profile.data.profile ? (
        <Banner tone="warning">{t("import.noProfile")}</Banner>
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
        disabled={!online || files.length === 0 || run.isPending || profile.isPending}
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
  const kind = search.kind ?? "received";
  return (
    <Page title={t("import.title")} back={importBackLink(search.from)}>
      <nav aria-label={t("import.title")} className="flex flex-wrap gap-2">
        {IMPORT_KINDS.map((value) => (
          <Link
            key={value}
            to="/import"
            search={{ kind: value, ...(search.from ? { from: search.from } : {}) }}
            aria-current={value === kind ? "page" : undefined}
            className={cn(
              buttonVariants({ variant: value === kind ? "default" : "secondary", size: "sm" }),
            )}
          >
            {t(`import.kinds.${value}`)}
          </Link>
        ))}
      </nav>
      {kind === "clients" ? <ClientsImport /> : <InvoiceImport key={kind} kind={kind} />}
    </Page>
  );
}
