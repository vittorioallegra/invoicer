import { NATURA_TEXTS, type Natura } from "../totals";

/** Maximum length of `RiferimentoNormativo` (String100LatinType). */
export const RIFERIMENTO_NORMATIVO_MAX = 100;
/** Maximum length of one `Causale` (String200LatinType). */
export const CAUSALE_MAX = 200;

const REPLACEMENTS: [RegExp, string][] = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[‐-―−]/g, "-"],
  [/…/g, "..."],
  [/€/g, "EUR"],
  [/[•‣●]/g, "-"],
  [/[Ł]/g, "L"],
  [/[ł]/g, "l"],
  [/[\r\n\t\v\f]+/g, " "],
];

const LATIN = /[^ -~ -ÿ]/g;

/**
 * Makes free text acceptable to the XSD "Latin" string types (Basic Latin and Latin-1 only):
 * typographic quotes, dashes, the euro sign and line breaks are replaced, accents outside Latin-1
 * lose their marks, anything else becomes `?`. Optionally cut to `max` characters.
 */
export function toLatin(text: string, max?: number): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  out = out
    .replace(LATIN, (char) => {
      const base = char.normalize("NFD").replace(/[̀-ͯ]/g, "");
      return /^[ -~ -ÿ]+$/.test(base) ? base : "?";
    })
    .replace(/ {2,}/g, " ")
    .trim();
  return max === undefined ? out : out.slice(0, max).trimEnd();
}

/**
 * `Descrizione` of a line: the description, then the optional note on a new line, at most 1000
 * characters (the editor refuses longer text). Line breaks inside the note are kept; the XSD
 * Latin types accept a line feed.
 */
export function lineDescription(line: { description: string; note?: string | undefined }): string {
  const note = (line.note ?? "")
    .split(/\r?\n/)
    .map((part) => toLatin(part))
    .filter(Boolean)
    .join("\n");
  const text = note ? `${toLatin(line.description)}\n${note}` : toLatin(line.description);
  return text.slice(0, 1000).trimEnd();
}

/** Cuts text into pieces of at most `max` characters, at word boundaries when possible. */
export function chunkText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const space = rest.lastIndexOf(" ", max);
    const cut = space > max / 2 ? space : max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * `RiferimentoNormativo` for a natura legal text. The element is limited to 100 characters, so a
 * longer text is shortened to the legal citation (from "art." on) and, if that still does not
 * fit, cut at a word boundary with "...". The complete text always travels in `Causale` (see
 * `naturaCausali`) and stays whole on the PDF.
 */
export function naturaReference(fullText: string): string {
  const text = toLatin(fullText);
  if (text.length <= RIFERIMENTO_NORMATIVO_MAX) return text;
  const citation = text.slice(Math.max(0, text.search(/\bart\./i)));
  if (citation.length <= RIFERIMENTO_NORMATIVO_MAX) return citation;
  const room = RIFERIMENTO_NORMATIVO_MAX - 3;
  const space = citation.lastIndexOf(" ", room);
  return `${citation.slice(0, space > room / 2 ? space : room).trimEnd()}...`;
}

/** The legal text of a natura as written on the invoice, falling back to the standard text. */
export function naturaFullText(
  natura: Natura,
  texts: Partial<Record<Natura, string | undefined>>,
): string {
  return toLatin(texts[natura]?.trim() || NATURA_TEXTS[natura].text);
}
