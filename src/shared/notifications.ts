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

/**
 * The page a notification opens (in-app link and push deep link): its invoice when it has one
 * (the courtesy email offer card lives there), the Received list for a received invoice, else
 * the notification list.
 */
export function notificationPath(type: string, invoiceId: string | null): string {
  if (invoiceId) return `/invoices/${invoiceId}`;
  if (type === "received_invoice") return "/received";
  return "/notifications";
}

/** Fills `{{name}}` placeholders (the Worker has no i18n library); missing values become empty. */
export function fillTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key] ?? ""));
}
