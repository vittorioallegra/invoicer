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

/** IBAN: country, check digits, mod-97 check (ISO 13616). Spaces are ignored by the caller. */
export function isValidIban(value: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) return false;
  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const text = (max: number) => z.string().trim().max(max);
const required = (max: number) => text(max).min(1);
/** Optional text field: an empty string means "not set". */
const optional = (max: number) => text(max).transform((value) => value || null);

const upper = (value: string) => value.replaceAll(/\s+/g, "").toUpperCase();

export const paymentDefaultsSchema = z.object({
  iban: z
    .string()
    .transform(upper)
    .refine((value) => value === "" || isValidIban(value), "invalid_iban")
    .transform((value) => value || null),
  bic: z
    .string()
    .transform(upper)
    .refine((value) => value === "" || /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(value), {
      message: "invalid_bic",
    })
    .transform((value) => value || null),
  accountHolder: optional(140),
  bankName: optional(140),
});
export type PaymentDefaults = z.infer<typeof paymentDefaultsSchema>;

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
  regimeFiscale: z.enum(REGIME_FISCALE_CODES),
  paymentDefaults: paymentDefaultsSchema,
  defaultPaymentTermsDays: z.number().int().min(0).max(365).nullable(),
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

/** Smallest number the owner may set next: one above the highest number already used. */
export function minimumNextNumber(highestUsed: number | null): number {
  return (highestUsed ?? 0) + 1;
}
