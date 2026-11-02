import type { TFunction } from "i18next";
import type { FatturaBuildError } from "../../shared/fatturapa/builder";
import type { MappedXsdErrors, XsdProblem } from "../../shared/fatturapa/xsd-errors";

/** Plain-language sentence for one mapped XSD problem (`fatturapa.*` in the locale files). */
export function describeXsdProblem(t: TFunction, problem: XsdProblem): string {
  const field = t(`fatturapa.fields.${problem.field}`);
  if (problem.index !== null) {
    return t(`fatturapa.lineKinds.${problem.kind}`, { n: problem.index + 1, field });
  }
  return t(`fatturapa.kinds.${problem.kind}`, { field });
}

/** The sentences to show and the raw messages for the "technical details" disclosure. */
export function describeXsdErrors(
  t: TFunction,
  mapped: MappedXsdErrors,
): { sentences: string[]; technical: string[] } {
  return {
    sentences: mapped.problems.map((problem) => describeXsdProblem(t, problem)),
    technical: mapped.technical,
  };
}

/** Message for a failed XML build (missing exchange rate, incomplete lines). */
export function describeBuildError(t: TFunction, error: FatturaBuildError): string {
  return t(`fatturapa.buildErrors.${error.code}`);
}
