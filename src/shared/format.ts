export type UiLocale = "en" | "it";

const INTL_LOCALE: Record<UiLocale, string> = { en: "en-IE", it: "it-IT" };

/** Formats integer cents for display (domain code stays in cents; this is display only). */
export function formatMoney(cents: number, locale: UiLocale, currency = "EUR"): string {
  // it-IT leaves 4-digit amounts ungrouped ("1040,00 €"); invoices read better as "1.040,00 €".
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: "currency",
    currency,
    useGrouping: "always",
  }).format(cents / 100);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Formats a calendar date. Date-only strings (YYYY-MM-DD, the storage format for issue dates)
 * are shown as written, with no timezone shift.
 */
export function formatDate(value: string | Date, locale: UiLocale): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: "medium" };
  if (typeof value === "string" && DATE_ONLY.test(value)) {
    return new Intl.DateTimeFormat(INTL_LOCALE[locale], { ...options, timeZone: "UTC" }).format(
      new Date(`${value}T00:00:00Z`),
    );
  }
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], options).format(new Date(value));
}

export function resolveLocale(languages: readonly string[]): UiLocale {
  return languages.some((l) => l.toLowerCase().startsWith("it")) ? "it" : "en";
}
