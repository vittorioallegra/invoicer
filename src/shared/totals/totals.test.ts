import { describe, expect, it } from "vitest";
import { INVOICE_FIXTURES } from "../fixtures/invoices";
import { computeTotals, defaultCassaSubjectToRitenuta } from "./calc";
import { NATURA_TEXTS } from "./natura";
import { NATURA_CODES, type TotalsInput, type TotalsLine } from "./types";

const vat = (cents: number, vatRateBp: number): TotalsLine => ({
  description: "x",
  quantityMilli: 1000,
  unitPriceCents: cents,
  vatRateBp,
  natura: null,
});
const exempt = (cents: number, natura: TotalsLine["natura"]): TotalsLine => ({
  description: "x",
  quantityMilli: 1000,
  unitPriceCents: cents,
  vatRateBp: null,
  natura,
});
const base = (over: Partial<TotalsInput>): TotalsInput => ({
  documentType: "TD01",
  currency: "EUR",
  lines: [],
  bollo: false,
  ...over,
});

describe("fixtures (a)-(g) totals to the cent", () => {
  for (const f of INVOICE_FIXTURES) {
    it(`fixture ${f.id}: ${f.title}`, () => {
      const t = computeTotals(f);
      expect(t.contributionCents).toBe(f.expected.contributionCents);
      expect(t.taxableCents).toBe(f.expected.taxableCents);
      expect(t.vatCents).toBe(f.expected.vatCents);
      expect(t.ritenutaCents).toBe(f.expected.ritenutaCents);
      expect(t.stampCents).toBe(f.expected.stampCents);
      expect(t.documentTotalCents).toBe(f.expected.documentTotalCents);
      expect(t.amountDueCents).toBe(f.expected.amountDueCents);
      expect(t.lines).toEqual(f.expected.lines);
      expect(t.currency).toBe(f.currency);
    });
  }

  it("fixture f: typed 1,040.00 and 999.99 split exactly", () => {
    const [f1, f2] = ["f1", "f2"].map((id) => {
      const f = INVOICE_FIXTURES.find((x) => x.id === id);
      if (!f) throw new Error(id);
      return computeTotals(f).lines[0];
    });
    expect(f1).toEqual({ amountCents: 104000, baseCents: 100000, contributionCents: 4000 });
    expect(f2?.baseCents).toBe(96153);
    expect((f2?.baseCents ?? 0) + (f2?.contributionCents ?? 0)).toBe(99999);
  });

  it("fixture g: credit note carries a negative sign, amounts stay positive", () => {
    const g = INVOICE_FIXTURES.find((x) => x.id === "g");
    if (!g) throw new Error("g");
    const t = computeTotals(g);
    expect(t.sign).toBe(-1);
    expect(t.amountDueCents).toBe(20781);
    expect(t.signedAmountDueCents).toBe(-20781);
  });

  it("natura fixtures carry the legal text constant", () => {
    for (const f of INVOICE_FIXTURES.filter((x) => x.naturaText)) {
      const natura = f.lines[0]?.natura;
      expect(natura && NATURA_TEXTS[natura].text).toBe(f.naturaText);
    }
  });
});

describe("rules", () => {
  it("rounds half up per line and per group", () => {
    // 0.5 x 0.05 = 0.025 -> 0.03 ; VAT 22% on 0.03 = 0.0066 -> 0.01
    const t = computeTotals(base({ lines: [{ ...vat(5, 2200), quantityMilli: 500 }] }));
    expect(t.lines[0]?.amountCents).toBe(3);
    expect(t.vatCents).toBe(1);
  });

  it("takes each rate group's rate on the contribution (mixed rates)", () => {
    // 22%: 1000.00 + 40.00 -> VAT 228.80 ; 10%: 500.00 + 20.00 -> VAT 52.00
    const t = computeTotals(
      base({
        lines: [vat(100000, 2200), vat(50000, 1000)],
        cassa: { type: "TC04", rateBp: 400, mode: "excluded", subjectToRitenuta: false },
      }),
    );
    expect(t.groups.map((g) => [g.vatRateBp, g.taxableCents, g.vatCents])).toEqual([
      [2200, 104000, 22880],
      [1000, 52000, 5200],
    ]);
    expect(t.contributionCents).toBe(6000);
    expect(t.documentTotalCents).toBe(156000 + 28080);
  });

  it("gives the contribution the same natura when lines are exempt", () => {
    const t = computeTotals(
      base({
        lines: [exempt(100000, "N4")],
        cassa: { type: "rivalsa_inps", rateBp: 400, mode: "excluded", subjectToRitenuta: true },
      }),
    );
    expect(t.groups).toEqual([
      { key: "natura:N4", vatRateBp: null, natura: "N4", taxableCents: 104000, vatCents: 0 },
    ]);
  });

  it("splits `included` line by line, not per rate group", () => {
    // Two typed 0.05 lines: per line base = round(0.05/1.04) = 0.05 (0.048) -> contribution 0;
    // a grouped split of 0.10 would give base 0.10 (0.096) and contribution 0: use 0.13 each.
    // 0.13/1.04 = 0.125 -> 0.13 (half up) so the contribution is 0 per line.
    const t = computeTotals(
      base({
        lines: [vat(13, 2200), vat(13, 2200)],
        cassa: { type: "rivalsa_inps", rateBp: 400, mode: "included", subjectToRitenuta: true },
      }),
    );
    expect(t.lines.map((l) => l.baseCents)).toEqual([13, 13]);
    // A group split of 0.26 would give base 0.25 and contribution 0.01.
    expect(t.contributionCents).toBe(0);
  });

  it("applies ritenuta to rivalsa INPS but not to a cassa contribution", () => {
    const common = {
      lines: [vat(100000, 2200)],
      ritenuta: { type: "RT01", rateBp: 2000, causale: "A" },
    };
    const rivalsa = computeTotals(
      base({
        ...common,
        cassa: { type: "rivalsa_inps", rateBp: 400, mode: "excluded", subjectToRitenuta: true },
      }),
    );
    const cassa = computeTotals(
      base({
        ...common,
        cassa: { type: "TC04", rateBp: 400, mode: "excluded", subjectToRitenuta: false },
      }),
    );
    expect(rivalsa.ritenutaCents).toBe(20800);
    expect(cassa.ritenutaCents).toBe(20000);
    expect(defaultCassaSubjectToRitenuta("rivalsa_inps")).toBe(true);
    expect(defaultCassaSubjectToRitenuta("TC04")).toBe(false);
  });

  it("suggests bollo only when natura lines exceed 77.47, and adds it to the amount due", () => {
    const at = computeTotals(base({ lines: [exempt(7747, "N4")] }));
    const over = computeTotals(base({ lines: [exempt(7748, "N4")], bollo: true }));
    const taxable = computeTotals(base({ lines: [vat(100000, 2200), exempt(7747, "N4")] }));
    expect(at.bolloSuggested).toBe(false);
    expect(over.bolloSuggested).toBe(true);
    expect(over.stampCents).toBe(200);
    expect(over.amountDueCents).toBe(7948);
    expect(taxable.bolloSuggested).toBe(false);
  });

  it("keeps the stamp out of VAT and ritenuta", () => {
    const t = computeTotals(
      base({
        lines: [vat(100000, 2200)],
        bollo: true,
        ritenuta: { type: "RT01", rateBp: 2000, causale: "A" },
      }),
    );
    expect(t.vatCents).toBe(22000);
    expect(t.ritenutaCents).toBe(20000);
    expect(t.amountDueCents).toBe(122000 + 200 - 20000);
  });

  it("rejects a line with both or neither of VAT rate and natura", () => {
    expect(() => computeTotals(base({ lines: [{ ...vat(100, 0) }] }))).toThrow();
    expect(() => computeTotals(base({ lines: [{ ...vat(100, 2200), natura: "N4" }] }))).toThrow();
  });
});

describe("natura texts", () => {
  it("covers every code, with N2.1 and N2.2 as specified", () => {
    for (const code of NATURA_CODES) expect(NATURA_TEXTS[code].text.length).toBeGreaterThan(10);
    expect(NATURA_TEXTS["N2.1"].text).toContain("art. 7-ter");
    expect(NATURA_TEXTS["N2.2"]).toEqual({
      text: "Operazione effettuata ai sensi dell'art. 1, commi 54-89, L. 190/2014",
      requirement: "mandatory",
    });
  });
});
