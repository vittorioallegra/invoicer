import { describe, expect, it } from "vitest";
import {
  emailSettingsInputSchema,
  isValidTaxCode,
  isValidVatNumber,
  minimumNextNumber,
  profileInputSchema,
} from "./profile";

const profile = {
  name: "Mario Rossi",
  vatNumber: "12345678903",
  taxCode: "",
  address: "Via Roma 1",
  postalCode: "00100",
  city: "Roma",
  province: "rm",
  country: "it",
  regimeFiscale: "RF19",
};

describe("identifier checks", () => {
  it("validates the partita IVA check digit", () => {
    expect(isValidVatNumber("12345678903")).toBe(true);
    expect(isValidVatNumber("12345678900")).toBe(false);
    expect(isValidVatNumber("1234567890")).toBe(false);
  });

  it("accepts a person or company codice fiscale", () => {
    expect(isValidTaxCode("RSSMRA80A01H501U")).toBe(true);
    expect(isValidTaxCode("12345678903")).toBe(true);
    expect(isValidTaxCode("RSSMRA80A01H501")).toBe(false);
  });
});

describe("profile input", () => {
  it("normalises case, spaces, the IT prefix and empty optionals", () => {
    const parsed = profileInputSchema.parse({ ...profile, vatNumber: "IT 12345678903" });
    expect(parsed).toMatchObject({
      vatNumber: "12345678903",
      taxCode: null,
      province: "RM",
      country: "IT",
    });
  });

  it("reports stable codes per field", () => {
    const result = profileInputSchema.safeParse({
      ...profile,
      vatNumber: "123",
      postalCode: "1",
      regimeFiscale: "RF03",
    });
    expect(result.success).toBe(false);
    const messages = new Map(result.error?.issues.map((i) => [i.path.join("."), i.message]));
    expect(messages.get("vatNumber")).toBe("invalid_vat_number");
    expect(messages.get("postalCode")).toBe("invalid_postal_code");
    expect(messages.has("regimeFiscale")).toBe(true);
  });
});

describe("email settings and numbering", () => {
  it("checks addresses and keeps empty ones as null", () => {
    expect(
      emailSettingsInputSchema.parse({
        senderName: "",
        senderAddress: "",
        replyTo: "a@b.it",
        bcc: "",
        mode: "ask",
      }),
    ).toEqual({ senderName: null, senderAddress: null, replyTo: "a@b.it", bcc: null, mode: "ask" });
    expect(
      emailSettingsInputSchema.safeParse({
        replyTo: "nope",
        mode: "ask",
        senderName: "",
        senderAddress: "",
        bcc: "",
      }).success,
    ).toBe(false);
  });

  it("allows numbers from one above the highest used", () => {
    expect(minimumNextNumber(null)).toBe(1);
    expect(minimumNextNumber(41)).toBe(42);
  });
});
