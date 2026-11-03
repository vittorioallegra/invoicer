import { z } from "zod";

/** FatturaPA `RegimeFiscale` codes (the schema has no RF03). */
export const REGIME_FISCALE_CODES = [
  "RF01",
  "RF02",
  "RF04",
  "RF05",
  "RF06",
  "RF07",
  "RF08",
  "RF09",
  "RF10",
  "RF11",
  "RF12",
  "RF13",
  "RF14",
  "RF15",
  "RF16",
  "RF17",
  "RF18",
  "RF19",
] as const;
export type RegimeFiscale = (typeof REGIME_FISCALE_CODES)[number];

export const COURTESY_EMAIL_MODES = ["automatic", "ask", "off"] as const;
export type CourtesyEmailMode = (typeof COURTESY_EMAIL_MODES)[number];

/** Partita IVA: 11 digits with the standard Luhn-like check digit. */
export function isValidVatNumber(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    let digit = Number(value[i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Codice fiscale: 16 alphanumeric characters (person) or 11 digits (company, like a P.IVA). */
export function isValidTaxCode(value: string): boolean {
  return /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/.test(value) || /^\d{11}$/.test(value);
}

const text = (max: number) => z.string().trim().max(max);
const required = (max: number) => text(max).min(1);
/** Optional text field: an empty string means "not set". */
const optional = (max: number) => text(max).transform((value) => value || null);

const upper = (value: string) => value.replaceAll(/\s+/g, "").toUpperCase();

/** Issuer profile as the owner submits it. Validation messages are stable codes for the UI. */
export const profileInputSchema = z.object({
  name: required(80),
  vatNumber: z
    .string()
    .transform((value) => value.replaceAll(/\s+/g, "").replace(/^IT/i, ""))
    .refine(isValidVatNumber, "invalid_vat_number"),
  taxCode: z
    .string()
    .transform(upper)
    .refine((value) => value === "" || isValidTaxCode(value), "invalid_tax_code")
    .transform((value) => value || null),
  address: required(60),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/, "invalid_postal_code"),
  city: required(60),
  province: z
    .string()
    .transform(upper)
    .refine((value) => value === "" || /^[A-Z]{2}$/.test(value), "invalid_province")
    .transform((value) => value || null),
  country: z
    .string()
    .transform(upper)
    .refine((value) => /^[A-Z]{2}$/.test(value), "invalid_country"),
});
export type ProfileInput = z.input<typeof profileInputSchema>;
export type ProfileData = z.output<typeof profileInputSchema>;

const emailAddress = z
  .string()
  .trim()
  .max(254)
  .refine((value) => value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), "invalid_email")
  .transform((value) => value || null);

export const emailSettingsInputSchema = z.object({
  senderName: optional(80),
  senderAddress: emailAddress,
  replyTo: emailAddress,
  bcc: emailAddress,
  mode: z.enum(COURTESY_EMAIL_MODES),
});
export type EmailSettingsInput = z.input<typeof emailSettingsInputSchema>;
export type EmailSettings = z.output<typeof emailSettingsInputSchema>;
