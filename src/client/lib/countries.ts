import { EU_COUNTRY_CODES } from "../../shared/client";

/** Common non-EU countries (ISO 3166-1 alpha-2) offered for non-EU clients. */
const NON_EU_COUNTRY_CODES = [
  "AD",
  "AE",
  "AL",
  "AM",
  "AR",
  "AU",
  "AZ",
  "BA",
  "BH",
  "BR",
  "BY",
  "CA",
  "CH",
  "CL",
  "CN",
  "CO",
  "DZ",
  "EG",
  "GB",
  "GE",
  "HK",
  "ID",
  "IL",
  "IN",
  "IS",
  "JP",
  "KR",
  "KZ",
  "LI",
  "MA",
  "MC",
  "MD",
  "ME",
  "MK",
  "MX",
  "MY",
  "NG",
  "NO",
  "NZ",
  "PE",
  "PH",
  "PK",
  "QA",
  "RS",
  "RU",
  "SA",
  "SG",
  "SM",
  "TH",
  "TN",
  "TR",
  "TW",
  "UA",
  "US",
  "UY",
  "VA",
  "VN",
  "ZA",
] as const;

export interface CountryOption {
  code: string;
  name: string;
}

/** Countries for the picker, named in the UI language and sorted; keeps `current` selectable. */
export function countryOptions(
  kind: "eu" | "non_eu",
  language: string,
  current: string,
): CountryOption[] {
  const names = new Intl.DisplayNames([language], { type: "region" });
  const codes: string[] = [...(kind === "eu" ? EU_COUNTRY_CODES : NON_EU_COUNTRY_CODES)];
  if (current && !codes.includes(current)) codes.push(current);
  return codes
    .map((code) => ({ code, name: names.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name, language));
}

/** Country name in the UI language (the code itself when unknown). */
export function countryName(code: string, language: string): string {
  return new Intl.DisplayNames([language], { type: "region" }).of(code) ?? code;
}
