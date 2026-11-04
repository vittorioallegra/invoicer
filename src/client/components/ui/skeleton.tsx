import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

/** A pulsing placeholder block. Decorative: the wrapping region announces the loading. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

/** Placeholder rows shaped like the bordered invoice/received rows, while a list loads. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-label={t("common.loading")}>
      <ul
        aria-hidden
        className="flex flex-col divide-y divide-border overflow-hidden rounded-card border border-border bg-surface"
      >
        {Array.from({ length: rows }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder
          <li key={index} className="flex min-h-14 items-start gap-3 px-4 py-3">
            <span className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </span>
            <span className="flex flex-col items-end gap-2">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-12 rounded-full" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
