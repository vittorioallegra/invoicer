import { formatDate, type UiLocale } from "./format";

/**
 * Notification kinds the Worker writes. A notification row stores the i18n key of its title
 * (`notifications.<type>.title`) and the interpolation values as JSON in `body`; the client and
 * the push sender render both in the owner's language (`notifications.<type>.body`).
 */
export const NOTIFICATION_TYPES = [
  "invoice_delivered",
  "invoice_not_delivered",
  "invoice_rejected",
  "pec_send_error",
  "received_invoice",
  "invoice_due",
  "invoice_overdue",
  "mailbox_login_failed",
  "courtesy_email_ask",
  "courtesy_email_failed",
  "poll_failed",
  "message_oversize",
  "message_unreadable",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** Notifications about the PEC mailbox itself; they open the PEC settings, where it is fixed. */
export const MAILBOX_NOTIFICATION_TYPES: readonly string[] = ["mailbox_login_failed"];

/**
 * The page a notification opens (in-app link and push deep link): its invoice when it has one
 * (the courtesy email offer card lives there), the Received list for a received invoice, the PEC
 * settings for a mailbox problem, else the notification list.
 */
export function notificationPath(type: string, invoiceId: string | null): string {
  if (invoiceId) return `/invoices/${invoiceId}`;
  if (type === "received_invoice") return "/received";
  if (MAILBOX_NOTIFICATION_TYPES.includes(type)) return "/settings/pec";
  return "/notifications";
}

/** Fills `{{name}}` placeholders (the Worker has no i18n library); missing values become empty. */
export function fillTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key] ?? ""));
}

/**
 * Interpolation values ready to show: a calendar date (`YYYY-MM-DD`, how the Worker stores the
 * dates in a notification) is written in the reader's language like every other date in the app.
 */
export function displayValues(
  values: Record<string, unknown>,
  locale: UiLocale,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? formatDate(value, locale)
        : value,
    ]),
  );
}
