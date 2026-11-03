import { describe, expect, it } from "vitest";
import { ritenutaDefaultsSchema, taxInputSchema } from "./tax";

const cassa = { type: "TC04", rateBp: 400, mode: "excluded", subjectToRitenuta: false };
const ritenuta = { type: "RT01", rateBp: 2000, baseBp: 10000, causale: "A" };

const codes = (value: unknown) => {
  const result = taxInputSchema.safeParse(value);
  return result.success
    ? {}
    : Object.fromEntries(result.error.issues.map((i) => [i.path.join("."), i.message]));
};

describe("tax input", () => {
  it("accepts a regime with no cassa and no ritenuta", () => {
    expect(taxInputSchema.parse({ regimeFiscale: "RF19", cassa: null, ritenuta: null })).toEqual({
      regimeFiscale: "RF19",
      cassa: null,
      ritenuta: null,
    });
  });

  it("accepts a cassa and a ritenuta", () => {
    expect(taxInputSchema.safeParse({ regimeFiscale: "RF01", cassa, ritenuta }).success).toBe(true);
    const rivalsa = { ...cassa, type: "rivalsa_inps", subjectToRitenuta: true };
    expect(
      taxInputSchema.safeParse({ regimeFiscale: "RF01", cassa: rivalsa, ritenuta: null }).success,
    ).toBe(true);
  });

  it("rejects RF03 (not in the schema) and unknown types", () => {
    expect(Object.keys(codes({ regimeFiscale: "RF03", cassa: null, ritenuta: null }))).toEqual([
      "regimeFiscale",
    ]);
    expect(
      Object.keys(
        codes({ regimeFiscale: "RF01", cassa: { ...cassa, type: "TC99" }, ritenuta: null }),
      ),
    ).toEqual(["cassa.type"]);
    expect(
      Object.keys(
        codes({ regimeFiscale: "RF01", cassa: null, ritenuta: { ...ritenuta, type: "RT09" } }),
      ),
    ).toEqual(["ritenuta.type"]);
  });

  it("rejects a zero or non-numeric rate and a zero base", () => {
    expect(
      Object.keys(codes({ regimeFiscale: "RF01", cassa: { ...cassa, rateBp: 0 }, ritenuta: null })),
    ).toEqual(["cassa.rateBp"]);
    expect(
      Object.keys(
        codes({ regimeFiscale: "RF01", cassa: { ...cassa, rateBp: Number.NaN }, ritenuta: null }),
      ),
    ).toEqual(["cassa.rateBp"]);
    expect(
      Object.keys(
        codes({ regimeFiscale: "RF01", cassa: null, ritenuta: { ...ritenuta, baseBp: 0 } }),
      ),
    ).toEqual(["ritenuta.baseBp"]);
  });

  it("reads a ritenuta without a base as 100%", () => {
    expect(ritenutaDefaultsSchema.parse({ type: "RT01", rateBp: 2000, causale: "A" }).baseBp).toBe(
      10000,
    );
  });
});
