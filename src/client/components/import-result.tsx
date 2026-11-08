import { CircleCheck, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ImportItemResult } from "../../shared/import";
import { Button } from "./ui/button";

/**
 * The result screen of an import: "N imported, M skipped" and, for each file or row, what
 * happened and why it was skipped (a duplicate, a taken number, an unreadable file...).
 */
export function ImportResult({
  results,
  onAgain,
  linkFor,
  labelOf,
}: {
  results: ImportItemResult[];
  onAgain: () => void;
  /** A link to the stored record of an item (the existing invoice of a conflict, the new one). */
  linkFor?: (item: ImportItemResult) => ReactNode;
  /** Formats an item's label (CSV rows are "row 3"); defaults to the label as is. */
  labelOf?: (item: ImportItemResult) => string;
}) {
  const { t } = useTranslation();
  const imported = results.filter((item) => item.status === "imported").length;
  const skipped = results.length - imported;
  // Skipped items first: they are the ones the owner has to act on.
  // Labels are not unique (two archives may hold the same name), so each item keeps its position as key.
  const keyed = results.map((item, position) => ({ item, key: `result-${position}` }));
  const ordered = [
    ...keyed.filter(({ item }) => item.status === "skipped"),
    ...keyed.filter(({ item }) => item.status === "imported"),
  ];
  return (
    <section aria-labelledby="import-result" className="flex flex-col gap-4">
      <h2 id="import-result" role="status" className="text-lg font-semibold">
        {t("import.result.summary", { imported, skipped })}
      </h2>
      {results.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
          {ordered.map(({ item, key }) => (
            <li key={key} className="flex items-start gap-3 px-4 py-3 text-sm">
              {item.status === "imported" ? (
                <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
              ) : (
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block break-words font-medium">
                  {labelOf ? labelOf(item) : item.label}
                </span>
                <span className="block text-muted-foreground">
                  {item.status === "imported"
                    ? t(item.draft ? "import.result.draft" : "import.result.imported")
                    : t(`import.reason.${item.reason ?? "server_error"}`, {
                        detail: item.detail ?? "",
                        number: item.detail ?? "",
                      })}
                  {item.status === "imported" && item.detail
                    ? ` · ${t(`import.detail.${item.detail}`)}`
                    : null}
                </span>
                {linkFor?.(item)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <Button variant="secondary" className="w-fit" onClick={onAgain}>
        {t("import.result.again")}
      </Button>
    </section>
  );
}
