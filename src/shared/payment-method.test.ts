import { describe, expect, it } from "vitest";
import {
  isValidBic,
  isValidIban,
  maskIban,
  paymentDefaultsSchema,
  paymentMethodInputSchema,
} from "./payment-method";

describe("IBAN and BIC checks", () => {
  it("validates the IBAN mod-97 check", () => {
    expect(isValidIban("IT60X0542811101000000123456")).toBe(true);
    expect(isValidIban("DE89370400440532013000")).toBe(true);
    expect(isValidIban("IT61X0542811101000000123456")).toBe(false);
    expect(isValidIban("IT60X05428111010000001234")).toBe(false);
    expect(isValidIban("it60x0542811101000000123456")).toBe(false);
  });

  it("validates the BIC shape with an 8 or 11 character code", () => {
    expect(isValidBic("UNCRITMM")).toBe(true);
    expect(isValidBic("UNCRITMMXXX")).toBe(true);
    expect(isValidBic("UNCRITM")).toBe(false);
    expect(isValidBic("1NCRITMM")).toBe(false);
    expect(isValidBic("UNCRITMMXX")).toBe(false);
  });

  it("masks the middle of an IBAN", () => {
    expect(maskIban("IT60X0542811101000000123456")).toBe("IT60 •••• 3456");
    expect(maskIban("IT60 X054 2811 1010 0000 0123 456")).toBe("IT60 •••• 3456");
    expect(maskIban("IT60")).toBe("IT60");
  });
});

describe("payment method input", () => {
  const valid = {
    label: " Fineco ",
    iban: "IT60 X054 2811 1010 0000 0123 456",
    bic: "uncritmm",
    accountHolder: " Mario Rossi ",
  };

  it("normalises spaces, case and empty optionals", () => {
    expect(paymentMethodInputSchema.parse(valid)).toEqual({
      label: "Fineco",
      iban: "IT60X0542811101000000123456",
      bic: "UNCRITMM",
      accountHolder: "Mario Rossi",
    });
  });

  it("reports stable codes per field", () => {
    const result = paymentMethodInputSchema.safeParse({
      ...valid,
      label: "",
      iban: "IT00",
      bic: "X",
    });
    const messages = new Map(result.error?.issues.map((i) => [i.path.join("."), i.message]));
    expect(messages.get("label")).toBe("required");
    expect(messages.get("iban")).toBe("invalid_iban");
    expect(messages.get("bic")).toBe("invalid_bic");
    expect(paymentMethodInputSchema.safeParse({ ...valid, iban: "" }).success).toBe(false);
  });

  it("lets an invoice snapshot be empty", () => {
    expect(
      paymentDefaultsSchema.parse({ iban: "", bic: "", accountHolder: "", bankName: "" }),
    ).toEqual({ iban: null, bic: null, accountHolder: null, bankName: null });
  });
});
