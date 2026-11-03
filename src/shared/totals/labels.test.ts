import { describe, expect, it } from "vitest";
import {
  CASSA_TYPE_CODES,
  CAUSALE_PAGAMENTO_CODES,
  cassaTypeLabel,
  causalePagamentoLabel,
  NATURA_CODES,
  naturaLabel,
  ritenutaTypeLabel,
  vatRateLabel,
} from "./index";

describe("option labels", () => {
  it("describes the VAT rates in both languages", () => {
    expect(vatRateLabel(2200, "it")).toBe("22% — aliquota ordinaria");
    expect(vatRateLabel(1000, "en")).toBe("10% — reduced rate");
    expect(vatRateLabel(400, "it")).toBe("4% — aliquota minima");
    expect(vatRateLabel(1234, "it")).toBe("12,34%");
  });

  it("describes every natura code", () => {
    for (const code of NATURA_CODES) {
      for (const locale of ["it", "en"] as const) {
        expect(naturaLabel(code, locale).startsWith(`${code} — `)).toBe(true);
      }
    }
    expect(naturaLabel("N2.2", "it")).toBe("N2.2 — non soggette: altri casi (es. forfettario)");
  });

  it("describes every cassa code, the rivalsa and the ritenuta types", () => {
    for (const code of CASSA_TYPE_CODES) {
      expect(cassaTypeLabel(code, "en")).toMatch(new RegExp(`^${code} — .+`));
    }
    expect(cassaTypeLabel("TC22", "it")).toBe("TC22 — INPS (gestione separata)");
    expect(cassaTypeLabel("rivalsa_inps", "it")).toBe("Rivalsa INPS 4%");
    expect(ritenutaTypeLabel("RT04", "it")).toBe("RT04 — contributo ENASARCO");
    expect(ritenutaTypeLabel("RT01", "en")).toBe("RT01 — withholding, individuals");
  });

  it("describes every ritenuta payment cause in both languages", () => {
    for (const code of CAUSALE_PAGAMENTO_CODES) {
      for (const locale of ["it", "en"] as const) {
        expect(causalePagamentoLabel(code, locale)).toMatch(new RegExp(`^${code} — .{5,}`));
      }
    }
    expect(causalePagamentoLabel("A", "it")).toBe(
      "A — lavoro autonomo, arte o professione abituale",
    );
  });
});
