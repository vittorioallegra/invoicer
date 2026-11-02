/** Invoice lifecycle states (spec section 3). Order is the state rank used for guarded updates. */
export const INVOICE_STATES = [
  "draft",
  "planned",
  "sending",
  "sent",
  "delivered",
  "not_delivered",
  "rejected",
  "rejected_expired",
] as const;

export type InvoiceState = (typeof INVOICE_STATES)[number];

/** Payment status is derived/independent from the SdI state. */
export const PAYMENT_STATES = ["unpaid", "paid", "overdue"] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];
