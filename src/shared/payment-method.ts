import { z } from "zod";

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

/** BIC/SWIFT: 4-letter bank, 2-letter country, 2-character location, optional 3-character branch. */
export function isValidBic(value: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(value);
}

/** `IT60 ••••  •••• 3456`-style display: country, check digits and the last four characters. */
export function maskIban(iban: string): string {
  const compact = iban.replaceAll(/\s+/g, "");
  if (compact.length <= 8) return compact;
  return `${compact.slice(0, 4)} •••• ${compact.slice(-4)}`;
}

const text = (max: number) => z.string().trim().max(max);
/** Optional text field: an empty string means "not set". */
const optional = (max: number) => text(max).transform((value) => value || null);
const upper = (value: string) => value.replaceAll(/\s+/g, "").toUpperCase();

/** Bank details printed on an invoice (also the snapshot an invoice keeps). */
export const paymentDefaultsSchema = z.object({
  iban: z
    .string()
    .transform(upper)
    .refine((value) => value === "" || isValidIban(value), "invalid_iban")
    .transform((value) => value || null),
  bic: z
    .string()
    .transform(upper)
    .refine((value) => value === "" || isValidBic(value), { message: "invalid_bic" })
    .transform((value) => value || null),
  accountHolder: optional(140),
  bankName: optional(140),
});
export type PaymentDefaults = z.infer<typeof paymentDefaultsSchema>;

/** A bank account as the owner submits it. Validation messages are stable codes for the UI. */
export const paymentMethodInputSchema = z.object({
  label: text(40).min(1, "required"),
  iban: z
    .string()
    .transform(upper)
    .refine((value) => value !== "", "required")
    .refine((value) => value === "" || isValidIban(value), "invalid_iban"),
  bic: paymentDefaultsSchema.shape.bic,
  accountHolder: optional(140),
});
export type PaymentMethodInput = z.input<typeof paymentMethodInputSchema>;
export type PaymentMethodData = z.output<typeof paymentMethodInputSchema>;

export interface PaymentMethodRecord {
  id: string;
  label: string;
  iban: string;
  bic: string | null;
  accountHolder: string | null;
  isDefault: boolean;
}
