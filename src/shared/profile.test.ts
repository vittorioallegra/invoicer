import { describe, expect, it } from "vitest";
import {
  emailSettingsInputSchema,
  isValidTaxCode,
  isValidVatNumber,
  phoneForXml,
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
    });
    expect(result.success).toBe(false);
    const messages = new Map(result.error?.issues.map((i) => [i.path.join("."), i.message]));
    expect(messages.get("vatNumber")).toBe("invalid_vat_number");
    expect(messages.get("postalCode")).toBe("invalid_postal_code");
  });
});

describe("company contacts", () => {
  const parse = (extra: object) => profileInputSchema.safeParse({ ...profile, ...extra });
  const issue = (extra: object) => {
    const result = parse(extra);
    return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}:${i.message}`);
  };

  it("are optional and stored as null when empty or absent", () => {
    expect(parse({}).data).toMatchObject({ email: null, phone: null });
    expect(parse({ email: "  ", phone: " " }).data).toMatchObject({ email: null, phone: null });
  });

  it("accepts an address of 7 to 256 characters and trims it", () => {
    expect(parse({ email: " info@studio.it " }).data?.email).toBe("info@studio.it");
    expect(issue({ email: "a@b.c" })).toEqual(["email:invalid_email"]);
    expect(issue({ email: "no-at-sign.it" })).toEqual(["email:invalid_email"]);
    expect(issue({ email: `${"a".repeat(253)}@b.it` })).toEqual(["email:invalid_email"]);
  });

  it("keeps the phone as typed and derives a 5 to 12 digit XML value", () => {
    const cases: [string, string][] = [
      ["+39 366 593 1825", "393665931825"],
      ["0039 366 5931825", "393665931825"],
      ["366 593 1825", "3665931825"],
      ["091 1234567", "0911234567"],
      ["(06) 12.34-5678", "0612345678"],
      ["+39 06 1234 56789", "06123456789"],
    ];
    for (const [typed, xml] of cases) {
      expect(parse({ phone: ` ${typed} ` }).data?.phone).toBe(typed);
      expect(phoneForXml(typed)).toBe(xml);
      expect(phoneForXml(xml)).toBe(xml);
    }
  });

  it("rejects letters and numbers that give no 5 to 12 digit value, with a reason", () => {
    expect(issue({ phone: "06 abc 1234" })).toEqual(["phone:invalid_phone"]);
    expect(issue({ phone: "12" })).toEqual(["phone:invalid_phone_length"]);
    expect(issue({ phone: "+44 7911 123456 789" })).toEqual(["phone:invalid_phone_length"]);
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
});
