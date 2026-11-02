import {
  Ban,
  CalendarClock,
  CheckCheck,
  Circle,
  CircleCheck,
  CircleX,
  Loader,
  MailWarning,
  Pencil,
  Send,
  TriangleAlert,
} from "lucide-react";
import type { ComponentType } from "react";
import type { InvoiceState, PaymentState } from "../../shared/invoice-state";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export interface StatusEntry {
  /** i18n key under `status.` */
  label: InvoiceState | PaymentState;
  tone: Tone;
  /** The icon carries the meaning too: colour is never the only signal. */
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
}

/** Single source of truth for state label, colour and icon (spec section 3). */
export const STATUS_MAP: Record<InvoiceState | PaymentState, StatusEntry> = {
  draft: { label: "draft", tone: "neutral", icon: Pencil },
  planned: { label: "planned", tone: "info", icon: CalendarClock },
  sending: { label: "sending", tone: "info", icon: Loader },
  sent: { label: "sent", tone: "info", icon: Send },
  delivered: { label: "delivered", tone: "success", icon: CheckCheck },
  not_delivered: { label: "not_delivered", tone: "warning", icon: MailWarning },
  rejected: { label: "rejected", tone: "danger", icon: CircleX },
  rejected_expired: { label: "rejected_expired", tone: "danger", icon: Ban },
  paid: { label: "paid", tone: "success", icon: CircleCheck },
  unpaid: { label: "unpaid", tone: "neutral", icon: Circle },
  overdue: { label: "overdue", tone: "warning", icon: TriangleAlert },
};

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground border-border",
  info: "bg-info-soft text-info border-info/30",
  success: "bg-success-soft text-success border-success/30",
  warning: "bg-warning-soft text-warning border-warning/30",
  danger: "bg-danger-soft text-danger border-danger/30",
};
