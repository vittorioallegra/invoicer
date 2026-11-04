import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClientRowResult, ImportItemResult, RowProblem } from "../../shared/import";
import {
  type ColumnMap,
  CSV_FIELDS,
  type CsvField,
  guessMapping,
  parseCsv,
  previewRows,
} from "../import/clients-csv";
import { api } from "../lib/api";
import { useOnline } from "../lib/online";
import { ImportResult } from "./import-result";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Select } from "./ui/select";

const NONE = "";

/** "Address: This field is required." for each problem of a row. */
function problemText(t: TFunction, problems: readonly RowProblem[]): string {
  return problems
    .map(
      (problem) =>
        `${t(`import.csv.fields.${problem.field}`, { defaultValue: problem.field })}: ${t(
          `validation.${problem.code}`,
          { defaultValue: t("validation.invalid") },
        )}`,
    )
    .join(" ");
}

/**
 * Import of clients from a Fatture in Cloud CSV: the owner picks the file, checks (and may change)
 * which column feeds each field on a preview that lists every row with a problem, then imports the
 * valid rows. The result screen lists what was imported and what was skipped, and why.
 */
export function ClientsImport() {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState<ReturnType<typeof parseCsv> | null>(null);
  const [fileName, setFileName] = useState("");
  const [map, setMap] = useState<ColumnMap>({});
  const [readError, setReadError] = useState(false);
  const [results, setResults] = useState<ImportItemResult[] | null>(null);

  const rows = useMemo(() => (csv ? previewRows(csv, map) : []), [csv, map]);
  const valid = rows.filter((row) => row.client);
  const invalid = rows.filter((row) => !row.client);

  const run = useMutation({
    mutationFn: async () => {
      const sent = valid.map((row) => row.client);
      const answer =
        sent.length > 0
          ? await api<{ results: ClientRowResult[] }>("/api/clients/import", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ rows: sent }),
            })
          : { results: [] };
      let next = 0;
      return rows.map((row): ImportItemResult => {
        const label = t("import.csv.rowLabel", { line: row.line, name: row.name || "–" });
        if (!row.client) {
          return {
            label,
            status: "skipped",
            reason: "invalid_row",
            detail: problemText(t, row.problems),
          };
        }
        const result = answer.results[next++];
        if (result?.status === "imported") {
          return { label, status: "imported", ...(result.id ? { id: result.id } : {}) };
        }
        return {
          label,
          status: "skipped",
          reason: result?.reason ?? "server_error",
          detail: result?.problems ? problemText(t, result.problems) : "",
        };
      });
    },
    onSuccess: async (items) => {
      setResults(items);
      setCsv(null);
      await queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
  });

  const reset = () => {
    setResults(null);
    setCsv(null);
    setFileName("");
    setMap({});
  };

  if (results) return <ImportResult results={results} onAgain={reset} />;

  const choose = async (file: File | undefined) => {
    setReadError(false);
    if (!file) return;
    try {
      const parsed = parseCsv(await file.text());
      if (parsed.headers.length === 0 || parsed.rows.length === 0) throw new Error("empty");
      setCsv(parsed);
      setFileName(file.name);
      setMap(guessMapping(parsed.headers));
    } catch {
      setCsv(null);
      setReadError(true);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("import.clients.intro")}</p>
      <div className="flex flex-col gap-2">
        <label htmlFor="import-files" className="text-sm font-medium">
          {t("import.csv.file")}
        </label>
        <input
          id="import-files"
          type="file"
          accept=".csv,text/csv,text/plain"
          disabled={run.isPending}
          onChange={(event) => void choose(event.target.files?.[0])}
          className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-control file:border file:border-border file:bg-surface file:px-4 file:py-2 file:text-sm file:font-medium hover:file:bg-muted"
        />
      </div>
      {readError ? <Banner tone="danger">{t("import.csv.unreadable")}</Banner> : null}

      {csv ? (
        <>
          <section aria-labelledby="csv-columns" className="flex flex-col gap-3">
            <h2 id="csv-columns" className="text-base font-semibold">
              {t("import.csv.columns")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("import.csv.columnsHint")}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {CSV_FIELDS.map((field: CsvField) => (
                <Field key={field} label={t(`import.csv.fields.${field}`)}>
                  {(control) => (
                    <Select
                      {...control}
                      value={map[field] ?? NONE}
                      onChange={(event) =>
                        setMap((current) => {
                          const next = { ...current };
                          if (event.target.value === NONE) delete next[field];
                          else next[field] = event.target.value;
                          return next;
                        })
                      }
                    >
                      <option value={NONE}>{t("import.csv.noColumn")}</option>
                      {csv.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ))}
            </div>
          </section>

          <section aria-labelledby="csv-preview" className="flex flex-col gap-3">
            <h2 id="csv-preview" className="text-base font-semibold">
              {t("import.csv.preview", { file: fileName })}
            </h2>
            <p role="status" className="text-sm">
              {t("import.csv.counts", { ready: valid.length, problems: invalid.length })}
            </p>
            {invalid.length > 0 ? (
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-card border border-warning/40 bg-warning-soft">
                {invalid.map((row) => (
                  <li key={row.line} className="px-4 py-3 text-sm">
                    <span className="block font-medium">
                      {t("import.csv.rowLabel", { line: row.line, name: row.name || "–" })}
                    </span>
                    <span className="block text-muted-foreground">
                      {problemText(t, row.problems)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {valid.length > 0 ? (
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
                {valid.slice(0, 5).map((row) => (
                  <li key={row.line} className="px-4 py-3 text-sm">
                    <span className="block font-medium">{row.name}</span>
                    <span className="block text-muted-foreground">
                      {[row.client?.vatNumber || row.client?.taxCode, row.client?.city]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {valid.length > 5 ? (
              <p className="text-sm text-muted-foreground">
                {t("import.csv.more", { count: valid.length - 5 })}
              </p>
            ) : null}
          </section>
          {run.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
          <Button
            className="w-fit"
            disabled={!online || run.isPending || rows.length === 0}
            onClick={() => run.mutate()}
          >
            {run.isPending
              ? t("import.csv.importing")
              : t("import.csv.start", { count: valid.length })}
          </Button>
        </>
      ) : null}
    </div>
  );
}
