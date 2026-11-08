import { describe, expect, it } from "vitest";
import { assembleDraft, deriveTerms } from "./invoice-draft";

describe("deriveTerms", () => {
  it("finds the terms that give the due date", () => {
    expect(deriveTerms("2026-11-10", "2026-11-10")).toEqual({ kind: "invoice_date" });
    expect(deriveTerms("2026-11-10", "2026-12-31")).toEqual({ kind: "eom_30" });
    expect(deriveTerms("2026-11-10", "2027-01-31")).toEqual({ kind: "eom_60" });
    expect(deriveTerms("2026-11-10", "2026-12-15")).toEqual({ kind: "eom_15" });
    expect(deriveTerms("2026-11-10", "2026-12-10")).toEqual({ kind: "custom", days: 30 });
  });

  it("gives nothing for a due date before the invoice or too far after it", () => {
    expect(deriveTerms("2026-11-10", "2026-11-01")).toBeNull();
    expect(deriveTerms("2026-11-10", "2028-11-10")).toBeNull();
  });
});

describe("assembleDraft", () => {
  const line = {
    description: "Work",
    note: "",
    quantityMilli: 1000,
    unit: null,
    unitPriceCents: 1000,
    vatRateBp: null,
    natura: "N2.2" as const,
  };
  it("adds the legal text of each natura and keeps an unmatched due date", () => {
    const body = assembleDraft(
      {
        documentType: "TD01",
        currency: "EUR",
        date: "2026-11-10",
        lines: [line],
        cassa: null,
        ritenuta: null,
        bollo: "client",
        note: "",
        payment: { method: "MP08", account: null, dueDate: "2028-01-01" },
      },
      { clientId: null, seriesId: null, requestedNumber: 4 },
    );
    expect(body.data.naturaTexts["N2.2"]).toContain("190/2014");
    expect(body).toMatchObject({ dueDate: "2028-01-01", requestedNumber: 4 });
    expect(body.data).toMatchObject({ bollo: true, bolloCharge: "client" });
    expect(body.data.payment).toMatchObject({ method: "MP08", terms: null, iban: null });
  });
});
