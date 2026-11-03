import type { XsdError } from "./validate";

/**
 * Maps XSD validation errors (libxml2 wording, element names of the FatturaPA schema) to the
 * fields the owner knows from the editor, so the UI can say "client: address is missing" instead
 * of showing `Element 'Indirizzo': [facet 'pattern'] ...`. Pure and independent of xmllint-wasm
 * (it only needs the error list and the validated XML), so it is safe to import anywhere.
 *
 * Text is not produced here: a problem carries a `field` key and a `kind`, translated by the
 * client through i18n (`fatturapa.fields.*`, `fatturapa.kinds.*`). Errors that cannot be placed on
 * a field are returned untouched in `technical`, for the "technical details" disclosure.
 */

export type XsdProblemKind = "required" | "invalid" | "too_long";

export interface XsdProblem {
  /** `scope.name` key, e.g. `client.address` or `lines.description`; see `FIELD_KEYS`. */
  field: string;
  /** 0-based line number for `lines.*` fields, else null. */
  index: number | null;
  kind: XsdProblemKind;
  /** The original libxml2 message, kept for the technical details. */
  raw: string;
}

export interface MappedXsdErrors {
  problems: XsdProblem[];
  /** Raw messages that could not be tied to a field. */
  technical: string[];
}

const PARTY_FIELDS: Record<string, string> = {
  Denominazione: "name",
  Nome: "name",
  Cognome: "name",
  IdPaese: "country",
  IdCodice: "vatNumber",
  CodiceFiscale: "taxCode",
  Indirizzo: "address",
  CAP: "postalCode",
  Comune: "city",
  Provincia: "province",
  Nazione: "country",
  RegimeFiscale: "regimeFiscale",
  Telefono: "phone",
  Email: "email",
};

const LINE_FIELDS: Record<string, string> = {
  Descrizione: "description",
  Quantita: "quantity",
  UnitaMisura: "unit",
  PrezzoUnitario: "price",
  PrezzoTotale: "price",
  AliquotaIVA: "vat",
  Natura: "vat",
};

const DOCUMENT_FIELDS: Record<string, string> = {
  Numero: "invoice.number",
  Data: "invoice.date",
  Divisa: "invoice.currency",
  Causale: "invoice.naturaText",
};

const PAYMENT_FIELDS: Record<string, string> = {
  ModalitaPagamento: "payment.method",
  DataScadenzaPagamento: "payment.dueDate",
  IBAN: "payment.iban",
  BIC: "payment.bic",
  IstitutoFinanziario: "payment.bankName",
  Beneficiario: "payment.accountHolder",
};

const SUMMARY_FIELDS = new Set(["AliquotaIVA", "Natura", "ImponibileImporto", "Imposta"]);

interface Place {
  /** Element names from the root to the element itself. */
  path: string[];
  /** Index of the enclosing DettaglioLinee, or null. */
  lineIndex: number | null;
}

/** Element path (and line-item index) of the first element named `name` that opens on `line`. */
function placeAtLine(xml: string, line: number, name: string): Place | null {
  const stack: { name: string; lineIndex: number | null }[] = [];
  let lines = 0;
  const rows = xml.split("\n");
  for (let row = 0; row < Math.min(line, rows.length); row++) {
    for (const match of (rows[row] ?? "").matchAll(/<(\/?)([A-Za-z0-9_.:-]+)[^>]*?(\/?)>/g)) {
      const [, closing, raw, selfClosing] = match;
      const tag = (raw ?? "").replace(/^.*:/, "");
      if (closing) {
        stack.pop();
        continue;
      }
      const lineIndex = tag === "DettaglioLinee" ? lines++ : (stack.at(-1)?.lineIndex ?? null);
      if (row === line - 1 && tag === name) {
        return {
          path: [...stack.map((frame) => frame.name), tag],
          lineIndex,
        };
      }
      if (!selfClosing) stack.push({ name: tag, lineIndex });
    }
  }
  return null;
}

/** The field a leaf element belongs to, from its ancestors. */
function fieldOf(parents: string[], leaf: string, lineIndex: number | null) {
  const within = (name: string) => parents.includes(name);
  const some = (field: string | undefined, index: number | null = null) =>
    field ? { field, index } : null;

  if (within("CedentePrestatore")) {
    const field = PARTY_FIELDS[leaf];
    return some(field && `issuer.${field}`);
  }
  if (within("CessionarioCommittente")) {
    const field = PARTY_FIELDS[leaf];
    return some(field && `client.${field}`);
  }
  if (within("IdTrasmittente"))
    return some(leaf === "IdCodice" ? "issuer.vatNumber" : "issuer.country");
  if (within("DatiTrasmissione")) {
    if (leaf === "CodiceDestinatario") return some("client.recipientCode");
    if (leaf === "PECDestinatario") return some("client.pec");
    return null;
  }
  if (within("DettaglioLinee")) {
    const field = LINE_FIELDS[leaf];
    return field ? { field: `lines.${field}`, index: lineIndex } : null;
  }
  if (within("DatiRiepilogo")) {
    if (leaf === "RiferimentoNormativo") return some("invoice.naturaText");
    return SUMMARY_FIELDS.has(leaf) ? some("lines.vat") : null;
  }
  if (within("DatiRitenuta")) return some("invoice.ritenuta");
  if (within("DatiBollo")) return some("invoice.bollo");
  if (within("DatiCassaPrevidenziale")) return some("invoice.cassa");
  if (within("DatiFattureCollegate")) return some("invoice.linked");
  if (within("DatiPagamento")) return some(PAYMENT_FIELDS[leaf]);
  if (within("DatiGeneraliDocumento")) return some(DOCUMENT_FIELDS[leaf]);
  return null;
}

interface Parsed {
  element: string;
  /** Child the schema expected instead (a missing element), when the message says so. */
  expected: string | null;
  kind: XsdProblemKind;
}

function parseMessage(message: string): Parsed | null {
  const element = /Element '(?:\{[^}]*\})?([^']+)'/.exec(message)?.[1];
  if (!element) return null;
  const expected = /Expected is \( (?:\{[^}]*\})?([A-Za-z0-9_.:-]+)/.exec(message)?.[1] ?? null;
  if (expected && /Missing child element|not expected/.test(message)) {
    return { element, expected, kind: "required" };
  }
  if (/\[facet 'maxLength'\]/.test(message)) return { element, expected: null, kind: "too_long" };
  if (
    /\[facet '(?:pattern|enumeration|minLength|length|minInclusive|maxInclusive)'\]/.test(message)
  ) {
    // The schema writes length limits as patterns (`...{1,80}`): a longer value is "too long".
    const limited =
      /The value '([\s\S]*)' is not accepted by the pattern '[^']*\{\d+,(\d+)\}'/.exec(message);
    if (limited && (limited[1] ?? "").length > Number(limited[2])) {
      return { element, expected: null, kind: "too_long" };
    }
    // An empty value is "missing" for the owner; anything else is "not valid".
    const empty = /The value '' /.test(message) || /\[facet 'minLength'\]/.test(message);
    return { element, expected: null, kind: empty ? "required" : "invalid" };
  }
  if (/is not a valid value of the atomic type|is not a valid value/.test(message)) {
    return { element, expected: null, kind: "invalid" };
  }
  return null;
}

/** Maps the errors of `validateFatturaXml` for the XML that was validated. */
export function mapXsdErrors(xml: string, errors: readonly XsdError[]): MappedXsdErrors {
  const problems: XsdProblem[] = [];
  const technical: string[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    const parsed = error.line === null ? null : parseMessage(error.message);
    const place =
      parsed && error.line !== null ? placeAtLine(xml, error.line, parsed.element) : null;
    let target: ReturnType<typeof fieldOf> = null;
    if (parsed && place) {
      target = parsed.expected
        ? // The schema expected `expected` inside the parent: for a "not expected" error the named
          // element is a sibling, for "missing child" it is the parent itself.
          fieldOf(
            parsed.kind === "required" && /Missing child/.test(error.message)
              ? place.path
              : place.path.slice(0, -1),
            parsed.expected,
            place.lineIndex,
          )
        : fieldOf(place.path.slice(0, -1), parsed.element, place.lineIndex);
    }
    if (!parsed || !target) {
      technical.push(error.message);
      continue;
    }
    const key = `${target.field}:${target.index}:${parsed.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push({
      field: target.field,
      index: target.index,
      kind: parsed.kind,
      raw: error.message,
    });
  }
  return { problems, technical };
}
