/** Where the "back" link on top of a page leads: a route and the i18n key of its label. */
export interface BackLink {
  to: "/" | "/invoices" | "/settings";
  labelKey: string;
}

export const SETTINGS_BACK: BackLink = { to: "/settings", labelKey: "pages.settings.title" };

/** Every invoice page goes back to the Invoices list (the only place to change if it moves). */
export const INVOICE_LIST_BACK: BackLink = { to: "/invoices", labelKey: "nav.invoices" };
