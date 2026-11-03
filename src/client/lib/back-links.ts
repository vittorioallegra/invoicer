/** Where the "back" link on top of a page leads: a route and the i18n key of its label. */
export interface BackLink {
  to: "/" | "/issued" | "/settings";
  labelKey: string;
}

export const SETTINGS_BACK: BackLink = { to: "/settings", labelKey: "pages.settings.title" };

/**
 * The invoice list an invoice page goes back to (the only place to change when the list route is
 * renamed): invoices still to send are listed on Home, sent ones under Issued.
 */
export const INVOICE_LIST_BACK = {
  unsent: { to: "/", labelKey: "nav.home" },
  issued: { to: "/issued", labelKey: "nav.issued" },
} as const satisfies Record<string, BackLink>;
