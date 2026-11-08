import { z } from "zod";
import { REGIME_FISCALE_CODES } from "./profile";
import { CASSA_TYPE_CODES, CAUSALE_PAGAMENTO_CODES } from "./totals/types";

/** FatturaPA `TipoRitenuta` codes. */
export const RITENUTA_TYPES = ["RT01", "RT02", "RT03", "RT04", "RT05", "RT06"] as const;

const rateBp = z.number().int().min(0).max(10000);

/** A cassa previdenziale / rivalsa INPS setting: the owner's in Tax details, copied onto an invoice. */
export const cassaDefaultsSchema = z.object({
  type: z.enum(["rivalsa_inps", ...CASSA_TYPE_CODES]),
  rateBp: rateBp.min(1),
  mode: z.enum(["excluded", "included"]),
  subjectToRitenuta: z.boolean(),
});

export type CassaDefaults = z.output<typeof cassaDefaultsSchema>;

/** A ritenuta d'acconto setting: the owner's in Tax details, copied onto an invoice. */
export const ritenutaDefaultsSchema = z.object({
  type: z.enum(RITENUTA_TYPES),
  rateBp: rateBp.min(1),
  /** Share of the amount subject to ritenuta the rate applies to (10000 = 100%); older rows lack it. */
  baseBp: rateBp.min(1).default(10000),
  causale: z.enum(CAUSALE_PAGAMENTO_CODES),
});

export type RitenutaDefaults = z.output<typeof ritenutaDefaultsSchema>;

/** The owner's fiscal options as the Tax details page submits them. */
export const taxInputSchema = z.object({
  regimeFiscale: z.enum(REGIME_FISCALE_CODES),
  cassa: cassaDefaultsSchema.nullable(),
  ritenuta: ritenutaDefaultsSchema.nullable(),
});
export type TaxInput = z.input<typeof taxInputSchema>;
export type TaxData = z.output<typeof taxInputSchema>;

/** What the invoice editor and the client form read: the cassa and ritenuta the owner configured. */
export type TaxOptions = Pick<TaxData, "cassa" | "ritenuta">;
export const EMPTY_TAX_OPTIONS: TaxOptions = { cassa: null, ritenuta: null };
