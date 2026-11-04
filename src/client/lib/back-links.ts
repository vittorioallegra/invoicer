/** Where the "back" link on top of a page leads: a route and the i18n key of its label. */
export interface BackLink {
  to: "/" | "/invoices" | "/received" | "/clients" | "/settings";
  labelKey: string;
}

export const SETTINGS_BACK: BackLink = { to: "/settings", labelKey: "pages.settings.title" };

/** Every invoice page goes back to the Invoices list (the only place to change if it moves). */
export const INVOICE_LIST_BACK: BackLink = { to: "/invoices", labelKey: "nav.invoices" };

/** Received invoice pages go back to the Received list. */
export const RECEIVED_BACK: BackLink = { to: "/received", labelKey: "nav.received" };

const CLIENTS_BACK: BackLink = { to: "/clients", labelKey: "nav.clients" };

/** The pages that link to `/import` (the `from` search param) and where the import page goes back. */
export const IMPORT_ORIGINS = ["invoices", "received", "clients", "settings"] as const;
export type ImportOrigin = (typeof IMPORT_ORIGINS)[number];

const IMPORT_BACK: Record<ImportOrigin, BackLink> = {
  invoices: INVOICE_LIST_BACK,
  received: RECEIVED_BACK,
  clients: CLIENTS_BACK,
  settings: SETTINGS_BACK,
};

/** The back link of the import page for the page it was opened from (Settings by default). */
export function importBackLink(from: ImportOrigin | undefined): BackLink {
  return IMPORT_BACK[from ?? "settings"];
}
