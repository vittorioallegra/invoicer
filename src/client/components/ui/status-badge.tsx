import { useTranslation } from "react-i18next";
import type { InvoiceState, PaymentState } from "../../../shared/invoice-state";
import { STATUS_MAP, TONE_CLASSES } from "../../lib/status";
import { cn } from "../../lib/utils";

/** State pill: icon + text label + colour, so colour is never the only signal. */
export function StatusBadge({
  status,
  detail,
  className,
}: {
  status: InvoiceState | PaymentState;
  /** Extra context (for example the paid date): a tooltip, and read after the label. */
  detail?: string | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const entry = STATUS_MAP[status];
  const Icon = entry.icon;
  return (
    <span
      title={detail}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE_CLASSES[entry.tone],
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {t(`status.${entry.label}`)}
      {detail ? <span className="sr-only">{`, ${detail}`}</span> : null}
    </span>
  );
}

/** Marks an invoice that was read from a file instead of being issued in the app. */
export function ImportedBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      {t("import.badge")}
    </span>
  );
}

/** Marks a credit note (TD04) next to the invoice's name, like the other neutral chips. */
export function CreditNoteBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      {t("received.docType.TD04")}
    </span>
  );
}
