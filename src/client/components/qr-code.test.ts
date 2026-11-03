import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { qrMatrix } from "./qr-code";

describe("qrMatrix", () => {
  it("matches the size of uqr's own output for an otpauth URI", () => {
    const uri = "otpauth://totp/Invoicer:owner?secret=JBSWY3DPEHPK3PXP&issuer=Invoicer";
    const matrix = qrMatrix(uri);
    expect(matrix.length).toBe(encode(uri, { border: 0, ecc: "M" }).size);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
  });
});
