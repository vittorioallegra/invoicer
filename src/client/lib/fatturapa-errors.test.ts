import { describe, expect, it } from "vitest";
import { FatturaBuildError } from "../../shared/fatturapa/builder";
import { createI18n } from "../i18n";
import { describeBuildError, describeXsdErrors } from "./fatturapa-errors";

const mapped = {
  problems: [
    { field: "client.address", index: null, kind: "required", raw: "x" },
    { field: "lines.description", index: 1, kind: "too_long", raw: "y" },
  ],
  technical: ["Schemas validity error : something odd"],
} as const;

describe("XSD problems in plain language", () => {
  it("speaks English by default", async () => {
    const i18n = await createI18n("en");
    const result = describeXsdErrors(i18n.t, {
      problems: [...mapped.problems],
      technical: [...mapped.technical],
    });
    expect(result.sentences).toEqual([
      "Client address is missing.",
      "Line 2: the description is too long.",
    ]);
    expect(result.technical).toEqual(["Schemas validity error : something odd"]);
    expect(describeBuildError(i18n.t, new FatturaBuildError("totals_incomplete"))).toContain(
      "VAT rate",
    );
  });

  it("speaks Italian", async () => {
    const i18n = await createI18n("it");
    const result = describeXsdErrors(i18n.t, { problems: [...mapped.problems], technical: [] });
    expect(result.sentences[1]).toBe("Riga 2: descrizione troppo lunga.");
  });
});
