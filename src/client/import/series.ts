import {
  matchSeries,
  type NumberingSeriesData,
  type NumberingSeriesRecord,
  numberingSeriesInputSchema,
} from "../../shared/numbering";

/** The prefix and suffix around the last digit group of a printed number, e.g. `7/CH`. */
function splitNumber(raw: string): { prefix: string; suffix: string } | null {
  const match = /^(.*?)(\d{1,9})(\D*)$/.exec(raw);
  if (!match) return null;
  const [, prefix = "", , suffix = ""] = match;
  return prefix === "" && suffix === "" ? null : { prefix, suffix };
}

const seriesName = (prefix: string, suffix: string): string => {
  const base = `${prefix}${suffix}`.replace(/[^A-Za-z0-9]+/g, " ").trim();
  return base || "Imported";
};

/**
 * The numbering series that the issued numbers need and the owner does not have yet: a number
 * with a prefix or suffix (`7/CH`, `A-12`) only blocks reuse inside a series with those affixes.
 * Existing series are never changed; an affix pair that fails the series rules is left out (such
 * a number is stored without a progressive).
 */
export function missingSeries(
  numbers: readonly string[],
  existing: readonly Pick<
    NumberingSeriesRecord,
    "id" | "prefix" | "suffix" | "isDefault" | "name"
  >[],
): NumberingSeriesData[] {
  const taken = new Set(existing.map((series) => series.name.toLowerCase()));
  const created = new Map<string, NumberingSeriesData>();
  for (const raw of new Set(numbers)) {
    const parts = splitNumber(raw);
    if (!parts) continue;
    const key = `${parts.prefix}\u0000${parts.suffix}`;
    if (created.has(key)) continue;
    // The series rules would trim a space; a number with one is not a plain affix number.
    if (!/^[A-Za-z0-9\-/.]*$/.test(parts.prefix + parts.suffix)) continue;
    const matched = matchSeries(raw, existing);
    const current = existing.find((series) => series.id === matched.seriesId);
    // Already inside a series with affixes: nothing to add.
    if (matched.progressive !== null && current && (current.prefix || current.suffix)) continue;
    let name = seriesName(parts.prefix, parts.suffix);
    for (let n = 2; taken.has(name.toLowerCase()); n++)
      name = `${seriesName(parts.prefix, parts.suffix)} ${n}`;
    const parsed = numberingSeriesInputSchema.safeParse({
      name,
      prefix: parts.prefix,
      suffix: parts.suffix,
    });
    if (!parsed.success) continue;
    taken.add(name.toLowerCase());
    created.set(key, parsed.data);
  }
  return [...created.values()];
}
