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

/**
 * FatturaPA `Contatti/Email` (EmailContattiType): 7 to 256 characters, `.+@.+[.]+.+`. Stricter
 * than the XSD on whitespace so a typo is caught before the file is built.
 */
const contactEmail = z
  .string()
  .optional()
  .transform((value) => (value ?? "").trim())
  .refine(
    (value) =>
      value === "" ||
      (value.length >= 7 && value.length <= 256 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)),
    "invalid_email",
  )
  .transform((value) => value || null);

/**
 * The `Contatti/Telefono` value (TelFaxType: 5 to 12 Basic Latin characters) for a phone number as
 * typed: digits only, a leading `+` or `00` country prefix dropped; when still longer than 12
 * digits, the Italian country code 39 is dropped. Null when no 5 to 12 digit value results.
 * A value of 5 to 12 digits maps to itself, so rebuilding from the XML value is stable.
 */
export function phoneForXml(typed: string): string | null {
  const value = typed.trim();
  let digits = value.replaceAll(/\D/g, "");
  if (value.startsWith("00")) digits = digits.slice(2);
  if (digits.length > 12 && digits.startsWith("39")) digits = digits.slice(2);
  return digits.length >= 5 && digits.length <= 12 ? digits : null;
}

/**
 * The company phone as the owner types it (digits, spaces, dots, dashes, parentheses, a leading
 * `+` or `00`), stored and printed as typed; it must yield a valid XML value (`phoneForXml`).
 */
const contactPhone = z
  .string()
  .optional()
  .transform((value, ctx) => {
    const typed = (value ?? "").trim();
    if (typed === "") return null;
    if (typed.length > 30 || !/^\+?[\d\s.\-()]+$/.test(typed)) {
      ctx.addIssue({ code: "custom", message: "invalid_phone" });
      return z.NEVER;
    }
    if (phoneForXml(typed) === null) {
      ctx.addIssue({ code: "custom", message: "invalid_phone_length" });
      return z.NEVER;
    }
    return typed;
  });

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
  /** Company contacts, written in `CedentePrestatore/Contatti` and printed under the sender. */
  email: contactEmail,
  phone: contactPhone,
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
