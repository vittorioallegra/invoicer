import type { UiLocale } from "../format";
import type { CassaType, Natura } from "./types";

/**
 * Short human descriptions of the codes the owner picks from (VAT rate, natura, cassa/rivalsa
 * type, ritenuta type). One place for the editor, the client form and the PDF. The Italian text
 * follows the official FatturaPA names (Allegato A, specifiche tecniche v1.2.x) shortened to fit
 * a native select option; the English text is a faithful translation. Stored values are the codes.
 */

type Described = Readonly<Record<UiLocale, string>>;

const pair = (it: string, en: string): Described => ({ it, en });

/** Italian VAT rates the editor offers, in basis points. */
const VAT_RATE_TEXTS: Readonly<Record<number, Described>> = {
  2200: pair("aliquota ordinaria", "standard rate"),
  1000: pair("aliquota ridotta", "reduced rate"),
  500: pair("aliquota ridotta", "reduced rate"),
  400: pair("aliquota minima", "minimum rate"),
};

const NATURA_LABELS: Readonly<Record<Natura, Described>> = {
  N1: pair("escluse ex art. 15", "excluded (art. 15)"),
  "N2.1": pair(
    "non soggette: servizi a soggetti UE (art. 7-ter)",
    "not subject: services to EU customers (art. 7-ter)",
  ),
  "N2.2": pair(
    "non soggette: altri casi (es. forfettario)",
    "not subject: other cases (e.g. flat-rate regime)",
  ),
  "N3.1": pair("non imponibili: esportazioni", "not taxable: exports"),
  "N3.2": pair("non imponibili: cessioni intracomunitarie", "not taxable: intra-EU supplies"),
  "N3.3": pair("non imponibili: cessioni verso San Marino", "not taxable: supplies to San Marino"),
  "N3.4": pair("non imponibili: assimilate alle esportazioni", "not taxable: treated as exports"),
  "N3.5": pair("non imponibili: dichiarazione d'intento", "not taxable: declaration of intent"),
  "N3.6": pair(
    "non imponibili: altre operazioni fuori plafond",
    "not taxable: other transactions outside the plafond",
  ),
  N4: pair("esenti", "exempt"),
  N5: pair("regime del margine, IVA non esposta", "margin scheme, VAT not shown"),
  "N6.1": pair(
    "inversione contabile: rottami e materiali di recupero",
    "reverse charge: scrap and recovered materials",
  ),
  "N6.2": pair(
    "inversione contabile: oro, argento, oreficeria usata",
    "reverse charge: gold, silver, used jewellery",
  ),
  "N6.3": pair(
    "inversione contabile: subappalto edile",
    "reverse charge: construction subcontracting",
  ),
  "N6.4": pair("inversione contabile: cessione di fabbricati", "reverse charge: sale of buildings"),
  "N6.5": pair("inversione contabile: telefoni cellulari", "reverse charge: mobile phones"),
  "N6.6": pair("inversione contabile: prodotti elettronici", "reverse charge: electronic products"),
  "N6.7": pair(
    "inversione contabile: comparto edile e settori connessi",
    "reverse charge: construction and related sectors",
  ),
  "N6.8": pair("inversione contabile: settore energetico", "reverse charge: energy sector"),
  "N6.9": pair("inversione contabile: altri casi", "reverse charge: other cases"),
  N7: pair("IVA assolta in altro Stato UE", "VAT paid in another EU state"),
};

const CASSA_LABELS: Readonly<Record<string, Described>> = {
  rivalsa_inps: pair("Rivalsa INPS 4%", "INPS rivalsa 4%"),
  TC01: pair("Cassa Forense (avvocati e procuratori legali)", "Cassa Forense (lawyers)"),
  TC02: pair("Cassa dottori commercialisti", "Chartered accountants' fund"),
  TC03: pair("Cassa geometri", "Surveyors' fund"),
  TC04: pair("Inarcassa (ingegneri e architetti)", "Inarcassa (engineers and architects)"),
  TC05: pair("Cassa nazionale del notariato", "Notaries' national fund"),
  TC06: pair("Cassa ragionieri e periti commerciali", "Accountants and commercial experts' fund"),
  TC07: pair(
    "ENASARCO (agenti e rappresentanti di commercio)",
    "ENASARCO (agents and sales representatives)",
  ),
  TC08: pair("ENPACL (consulenti del lavoro)", "ENPACL (labour consultants)"),
  TC09: pair("ENPAM (medici)", "ENPAM (doctors)"),
  TC10: pair("ENPAF (farmacisti)", "ENPAF (pharmacists)"),
  TC11: pair("ENPAV (veterinari)", "ENPAV (veterinarians)"),
  TC12: pair("ENPAIA (impiegati dell'agricoltura)", "ENPAIA (agricultural employees)"),
  TC13: pair(
    "Fondo impiegati spedizioni e agenzie marittime",
    "Fund for shipping and maritime agency employees",
  ),
  TC14: pair("INPGI (giornalisti)", "INPGI (journalists)"),
  TC15: pair("ONAOSI (orfani dei sanitari)", "ONAOSI (orphans of health workers)"),
  TC16: pair(
    "CASAGIT (assistenza integrativa giornalisti)",
    "CASAGIT (journalists' supplementary care)",
  ),
  TC17: pair("EPPI (periti industriali)", "EPPI (industrial experts)"),
  TC18: pair("EPAP (pluricategoriale)", "EPAP (multi-category)"),
  TC19: pair("ENPAB (biologi)", "ENPAB (biologists)"),
  TC20: pair("ENPAPI (infermieri)", "ENPAPI (nurses)"),
  TC21: pair("ENPAP (psicologi)", "ENPAP (psychologists)"),
  TC22: pair("INPS (gestione separata)", "INPS (separate management)"),
};

const RITENUTA_LABELS: Readonly<Record<string, Described>> = {
  RT01: pair("ritenuta persone fisiche", "withholding, individuals"),
  RT02: pair("ritenuta persone giuridiche", "withholding, legal entities"),
  RT03: pair("contributo INPS", "INPS contribution"),
  RT04: pair("contributo ENASARCO", "ENASARCO contribution"),
  RT05: pair("contributo ENPAM", "ENPAM contribution"),
  RT06: pair("altro contributo previdenziale", "other social security contribution"),
};

const percent = (bp: number, locale: UiLocale) =>
  new Intl.NumberFormat(locale === "it" ? "it-IT" : "en-IE", { maximumFractionDigits: 2 }).format(
    bp / 100,
  );

/** "22% — aliquota ordinaria"; a rate without a description is just "N%". */
export function vatRateLabel(bp: number, locale: UiLocale): string {
  const text = VAT_RATE_TEXTS[bp]?.[locale];
  return text ? `${percent(bp, locale)}% — ${text}` : `${percent(bp, locale)}%`;
}

/** "N2.2 — non soggette: altri casi (es. forfettario)". */
export function naturaLabel(code: Natura, locale: UiLocale): string {
  return `${code} — ${NATURA_LABELS[code][locale]}`;
}

/** "TC04 — Inarcassa (...)"; "Rivalsa INPS 4%" for the rivalsa. */
export function cassaTypeLabel(type: CassaType | string, locale: UiLocale): string {
  const text = CASSA_LABELS[type]?.[locale];
  if (type === "rivalsa_inps") return text ?? type;
  return text ? `${type} — ${text}` : type;
}

/** "RT01 — ritenuta persone fisiche". */
export function ritenutaTypeLabel(code: string, locale: UiLocale): string {
  const text = RITENUTA_LABELS[code]?.[locale];
  return text ? `${code} — ${text}` : code;
}
