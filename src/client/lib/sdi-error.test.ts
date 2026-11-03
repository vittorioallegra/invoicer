import { describe, expect, it } from "vitest";
import { createI18n } from "../i18n";
import { sdiErrorLine } from "./sdi-error";

describe("sdiErrorLine", () => {
  it("joins code and text, and leaves no stray space when the code is empty", async () => {
    for (const [lng, label] of [
      ["en", "SdI error"],
      ["it", "Errore SdI"],
    ] as const) {
      const { t } = await createI18n(lng);
      expect(sdiErrorLine(t, { code: "00471", description: "Bad" })).toBe(`${label} 00471: Bad`);
      expect(sdiErrorLine(t, { code: "", description: "00471: Bad" })).toBe(`${label}: 00471: Bad`);
    }
  });
});
