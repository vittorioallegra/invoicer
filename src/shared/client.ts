import { z } from "zod";
import { legacyTerms, paymentTermsSchema } from "./payment-terms";
import { isValidVatNumber } from "./profile";

export const CLIENT_TYPES = [
  "it_company",
  "it_private",
  "eu_company",
  "non_eu_company",
  "foreign_private",
] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

/** What the owner picks first: a company or a private person. The type follows from kind + country. */
export type ClientKind = "company" | "private";

/** True for the types with an Italian address (partita IVA / codice fiscale, province). */
export function isItalianClientType(type: ClientType): boolean {
  return type === "it_company" || type === "it_private";
}

export function clientKind(type: ClientType): ClientKind {
  return type === "it_private" || type === "foreign_private" ? "private" : "company";
}

/** The stored type for a kind and a country (ISO 3166-1 alpha-2). */
export function deriveClientType(kind: ClientKind, countryCode: string): ClientType {
  if (countryCode === "IT") return kind === "company" ? "it_company" : "it_private";
  if (kind === "private") return "foreign_private";
  return (EU_COUNTRY_CODES as readonly string[]).includes(countryCode)
    ? "eu_company"
    : "non_eu_company";
}

/** Codice destinatario for Italian clients without a SdI channel code (PEC or portal delivery). */
export const RECIPIENT_CODE_ITALY_DEFAULT = "0000000";
/** Codice destinatario for foreign clients. */
export const RECIPIENT_CODE_FOREIGN = "XXXXXXX";

/** EU member states other than Italy (ISO 3166-1 alpha-2; Greece is EL in VAT numbers but GR here). */
export const EU_COUNTRY_CODES = [
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
] as const;

const ODD_VALUES = [
  1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23,
];

/** Personal codice fiscale: 16 characters with the check character (omocodia letters L-V in digit positions accepted). */
export function isValidPersonalTaxCode(value: string): boolean {
  if (
    !/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-EHLMPR-T][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(
      value,
    )
  ) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const char = value.charAt(i);
    const index = /\d/.test(char) ? Number(char) : char.charCodeAt(0) - 65;
    sum += i % 2 === 0 ? (ODD_VALUES[index] ?? 0) : index;
  }
  return String.fromCharCode(65 + (sum % 26)) === value.charAt(15);
}

/** Codice fiscale of a company: 11 digits, same check digit as the partita IVA. */
export function isValidCompanyTaxCode(value: string): boolean {
  return isValidVatNumber(value);
}

/** Either form of codice fiscale. */
export function isValidClientTaxCode(value: string): boolean {
  return isValidPersonalTaxCode(value) || isValidCompanyTaxCode(value);
}

/** True when the 7-character code looks like a SdI channel code (letters and digits). */
export function isValidRecipientCode(value: string): boolean {
  return /^[A-Z0-9]{7}$/.test(value);
}

/** Codice destinatario applied when the owner leaves it empty or the type fixes it. */
export function defaultRecipientCode(type: ClientType): string {
  return isItalianClientType(type) ? RECIPIENT_CODE_ITALY_DEFAULT : RECIPIENT_CODE_FOREIGN;
}

const text = (max: number) => z.string().trim().max(max);
const optional = (max: number) => text(max).transform((value) => value || null);
const squash = (value: string) => value.replaceAll(/\s+/g, "").toUpperCase();
const emailAddress = z
  .string()
  .trim()
  .max(254)
  .refine((value) => value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), "invalid_email")
  .transform((value) => value || null);

/**
 * Per-client invoice defaults. Cassa and ritenuta values live in Settings > Tax details; a client
 * only flags whether each applies, and a new invoice for it copies the owner's values. Older stored
 * rows carry the whole cassa / ritenuta objects (flag = one was set), plus VAT/natura and bollo
 * defaults that no longer exist; they are read and dropped. Older rows also carry
 * `paymentTermsDays` (a plain number); reading maps it to `terms` counted from the invoice date,
 * and only `terms` is written.
 */
export const clientDefaultsSchema = z
  .object({
    applyCassa: z.boolean().optional(),
    applyRitenuta: z.boolean().optional(),
    terms: paymentTermsSchema.nullable().optional(),
    /** Legacy input only: replaced by `applyCassa` / `applyRitenuta`. */
    cassa: z.unknown().optional(),
    ritenuta: z.unknown().optional(),
    /** Legacy input only: replaced by `terms`. */
    paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  })
  .transform(({ applyCassa, applyRitenuta, cassa, ritenuta, paymentTermsDays, terms }) => ({
    applyCassa: applyCassa ?? Boolean(cassa),
    applyRitenuta: applyRitenuta ?? Boolean(ritenuta),
    terms:
      terms ??
      (paymentTermsDays !== null && paymentTermsDays !== undefined
        ? legacyTerms(paymentTermsDays)
        : null),
  }));

export type ClientDefaults = z.output<typeof clientDefaultsSchema>;

export const EMPTY_CLIENT_DEFAULTS: ClientDefaults = {
  applyCassa: false,
  applyRitenuta: false,
  terms: null,
};

/** Defaults of a new client: the cassa applies; the ritenuta only for Italian companies (withholding agents). */
export function newClientDefaults(type: ClientType): ClientDefaults {
  return { applyCassa: true, applyRitenuta: type === "it_company", terms: null };
}

/** Rules per type, applied after the field checks: required fields and fixed values. */
const clientBaseSchema = z.object({
  type: z.enum(CLIENT_TYPES),
  name: text(80).min(1, "required"),
  vatNumber: z
    .string()
    .transform((value) => squash(value).replace(/^IT/, ""))
    .transform((value) => value || null),
  taxCode: z.string().transform(squash),
  foreignTaxId: optional(30),
  countryCode: z
    .string()
    .transform(squash)
    .refine((value) => /^[A-Z]{2}$/.test(value), "invalid_country"),
  address: text(60),
  postalCode: text(10),
  city: text(60),
  province: z.string().transform(squash),
  recipientCode: z.string().transform(squash),
  pec: emailAddress,
  email: emailAddress,
  pdfLanguage: z.enum(["it", "en"]),
  currency: z
    .string()
    .transform(squash)
    .refine((value) => /^[A-Z]{3}$/.test(value), "invalid_currency"),
  defaults: clientDefaultsSchema,
});

export const clientInputSchema = clientBaseSchema
  .superRefine((value, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const italian = isItalianClientType(value.type);
    if (value.vatNumber !== null && italian && !isValidVatNumber(value.vatNumber)) {
      fail("vatNumber", "invalid_vat_number");
    }
    if (value.type === "it_company" && value.vatNumber === null) fail("vatNumber", "required");
    if (value.taxCode !== "" && italian && !isValidClientTaxCode(value.taxCode)) {
      fail("taxCode", "invalid_tax_code");
    }
    if (value.type === "it_private") {
      if (value.taxCode === "") fail("taxCode", "required");
      else if (!isValidPersonalTaxCode(value.taxCode)) fail("taxCode", "invalid_tax_code");
    }
    if (italian) {
      if (value.countryCode !== "IT") fail("countryCode", "invalid_country");
      if (value.address === "") fail("address", "required");
      if (!/^\d{5}$/.test(value.postalCode)) fail("postalCode", "invalid_postal_code");
      if (value.city === "") fail("city", "required");
      if (!/^[A-Z]{2}$/.test(value.province)) fail("province", "invalid_province");
      if (value.recipientCode !== "" && !isValidRecipientCode(value.recipientCode)) {
        fail("recipientCode", "invalid_recipient_code");
      }
    } else {
      const eu = (EU_COUNTRY_CODES as readonly string[]).includes(value.countryCode);
      if (value.type === "eu_company" && !eu) fail("countryCode", "invalid_eu_country");
      if (value.type === "non_eu_company" && (eu || value.countryCode === "IT")) {
        fail("countryCode", "invalid_non_eu_country");
      }
      if (value.type === "foreign_private" && value.countryCode === "IT") {
        fail("countryCode", "invalid_foreign_country");
      }
      if (value.type === "eu_company" && value.foreignTaxId === null) {
        fail("foreignTaxId", "required");
      }
      if (value.address === "") fail("address", "required");
      if (value.postalCode === "") fail("postalCode", "required");
      if (value.city === "") fail("city", "required");
    }
  })
  .transform((value) => {
    const italian = isItalianClientType(value.type);
    return {
      ...value,
      taxCode: value.taxCode || null,
      // Italian private persons always use 0000000; foreign clients always XXXXXXX.
      recipientCode:
        value.type === "it_company"
          ? value.recipientCode || RECIPIENT_CODE_ITALY_DEFAULT
          : defaultRecipientCode(value.type),
      province: italian ? value.province : null,
      foreignTaxId: italian ? null : value.foreignTaxId,
      vatNumber: italian ? value.vatNumber : null,
      // A PEC is only a delivery channel for Italian clients.
      pec: italian ? value.pec : null,
    };
  });
export type ClientInput = z.input<typeof clientInputSchema>;
export type ClientData = z.output<typeof clientInputSchema>;

/** A stored client as the API returns it. */
export type ClientRecord = ClientData & { id: string };

/** A stored client as form-style input (nulls become empty strings), to run the type rules on it. */
export function clientRecordToInput(client: ClientRecord): ClientInput {
  return {
    ...client,
    vatNumber: client.vatNumber ?? "",
    taxCode: client.taxCode ?? "",
    foreignTaxId: client.foreignTaxId ?? "",
    province: client.province ?? "",
    pec: client.pec ?? "",
    email: client.email ?? "",
  };
}
