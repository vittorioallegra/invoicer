import { useTranslation } from "react-i18next";
import type { InvoiceState, PaymentState } from "../../../shared/invoice-state";
import { STATUS_MAP, TONE_CLASSES } from "../../lib/status";
import { cn } from "../../lib/utils";

/** State pill: icon + text label + colour, so colour is never the only signal. */
export function StatusBadge({
  status,
  className,
}: {
  status: InvoiceState | PaymentState;
  className?: string;
}) {
  const { t } = useTranslation();
  const entry = STATUS_MAP[status];
  const Icon = entry.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE_CLASSES[entry.tone],
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {t(`status.${entry.label}`)}
    </span>
  );
}
