import { describe, expect, it } from "vitest";
import {
  decodeFileProgressive,
  encodeFileProgressive,
  FILE_PROGRESSIVE_MAX,
  fatturaFileName,
} from "./file-name";

describe("file progressive", () => {
  it("encodes five upper-case base-36 digits", () => {
    expect(encodeFileProgressive(0)).toBe("00000");
    expect(encodeFileProgressive(1)).toBe("00001");
    expect(encodeFileProgressive(35)).toBe("0000Z");
    expect(encodeFileProgressive(36)).toBe("00010");
    expect(encodeFileProgressive(FILE_PROGRESSIVE_MAX)).toBe("ZZZZZ");
  });

  it("round-trips and rejects out-of-range values", () => {
    for (const value of [0, 7, 1296, 123456, FILE_PROGRESSIVE_MAX]) {
      expect(decodeFileProgressive(encodeFileProgressive(value))).toBe(value);
    }
    expect(decodeFileProgressive("abc")).toBeNull();
    expect(() => encodeFileProgressive(FILE_PROGRESSIVE_MAX + 1)).toThrow(RangeError);
    expect(() => encodeFileProgressive(-1)).toThrow(RangeError);
  });

  it("builds the SdI file name", () => {
    expect(fatturaFileName("IT", "01234567890", 37)).toBe("IT01234567890_00011.xml");
  });
});
