// @vitest-environment node
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { fixtureToFatturaInput } from "../../shared/fixtures/fatturapa";
import { INVOICE_FIXTURES } from "../../shared/fixtures/invoices";
import { formatMoney } from "../../shared/format";
import type { PaymentTerms } from "../../shared/payment-terms";
import type { InvoicePdfInput } from "./invoice-model";
import { renderInvoicePdf } from "./render";

/**
 * Minimal text extraction, enough for the standard Helvetica fonts the PDF uses: inflate every
 * stream and decode the hex strings of the text-showing operators (WinAnsi, one byte per glyph).
 */
function extractText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString("latin1");
  const parts: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(match[1] ?? "", "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const op of content.matchAll(
      /\[((?:<[0-9a-fA-F]*>|[-\d.\s])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g,
    )) {
      const hexes = [...(op[1] ?? op[2] ?? "").matchAll(/<([0-9a-fA-F]*)>/g)].map(
        (m) => m[1] ?? "",
      );
      if (op[2] !== undefined) hexes.push(op[2]);
      parts.push(
        hexes
          .map((h) => Buffer.from(h, "hex").toString("latin1").replaceAll("\u0080", "€"))
          .join(""),
      );
    }
  }
  return parts.join("\n").replaceAll(" ", " ");
}

function inputFor(id: string): InvoicePdfInput {
  const fixture = INVOICE_FIXTURES.find((f) => f.id === id);
  if (!fixture) throw new Error(`fixture ${id}`);
  const base = fixtureToFatturaInput(fixture);
  const { fileProgressive: _unused, ...rest } = base;
  return {
    ...rest,
    invoice: {
      ...rest.invoice,
      data: {
        ...rest.invoice.data,
        payment: { ...rest.invoice.data.payment, bic: "EXAMPLEXXX" },
      },
    },
    language: fixture.client.pdfLanguage,
  };
}

describe("invoice PDF (AC 13)", () => {
  it("fixture (c) is in English and shows the payment data, the natura text and the legal note", async () => {
    const text = extractText(await renderInvoicePdf(inputFor("c")));
    expect(text).toContain("Invoice");
    expect(text).toContain("Amount due");
    expect(text).toContain("IT60X0542811101000000123456");
    expect(text).toContain("EXAMPLEXXX");
    expect(text).toContain("Studio Example");
    expect(text).toContain("Due date");
    expect(text).toContain("20 May 2026");
    expect(text).toContain("Courtesy copy");
    expect(text).toContain("Operazione non soggetta a IVA ai sensi dell'art. 7-ter del DPR 633/72");
    expect(text).toContain("Stamp duty");
    expect(text).toContain("1,343.25");
    expect(text).not.toContain("Fattura");
  });

  it("fixture (b) is in Italian and shows the payment data", async () => {
    const text = extractText(await renderInvoicePdf(inputFor("b")));
    expect(text).toContain("Fattura");
    expect(text).toContain("Importo dovuto");
    expect(text).toContain("Intestatario");
    expect(text).toContain("Studio Example");
    expect(text).toContain("IT60X0542811101000000123456");
    expect(text).toContain("EXAMPLEXXX");
    expect(text).toContain("20 mag 2026");
    expect(text).toContain("Copia di cortesia");
    expect(text).not.toContain("Amount due");
  });
});

describe("invoice PDF payment terms", () => {
  const withTerms = (
    id: string,
    terms: PaymentTerms | null,
    dueDateCustom = false,
  ): InvoicePdfInput => {
    const input = inputFor(id);
    return {
      ...input,
      invoice: {
        ...input.invoice,
        dueDate: "2026-12-31",
        data: {
          ...input.invoice.data,
          payment: { ...input.invoice.data.payment, terms, dueDateCustom },
        },
      },
    };
  };

  it("prints the terms in words and the due date, in the PDF language", async () => {
    const it = extractText(await renderInvoicePdf(withTerms("b", { kind: "eom_30" })));
    expect(it).toContain("30 gg fine mese data fattura");
    expect(it).toContain("31 dic 2026");
    const en = extractText(await renderInvoicePdf(withTerms("c", { kind: "eom_30" })));
    expect(en).toContain("30 days end of month");
    expect(en).toContain("31 Dec 2026");
    const custom = extractText(
      await renderInvoicePdf(withTerms("c", { kind: "custom", days: 60 })),
    );
    expect(custom).toContain("60 days from invoice date");
    const customIt = extractText(
      await renderInvoicePdf(withTerms("b", { kind: "custom", days: 45 })),
    );
    expect(customIt).toContain("45 gg data fattura");
    const df = extractText(await renderInvoicePdf(withTerms("c", { kind: "invoice_date" })));
    expect(df).toContain("Invoice date");
    const dfIt = extractText(await renderInvoicePdf(withTerms("b", { kind: "invoice_date" })));
    expect(dfIt).toContain("Data fattura");
    const eom15 = extractText(await renderInvoicePdf(withTerms("c", { kind: "eom_15" })));
    expect(eom15).toContain("15 days end of month");
    const eom60It = extractText(await renderInvoicePdf(withTerms("b", { kind: "eom_60" })));
    expect(eom60It).toContain("60 gg fine mese data fattura");
  });

  it("prints only the due date without terms or with a custom date", async () => {
    for (const input of [
      withTerms("c", null),
      withTerms("c", { kind: "custom", days: 30 }, true),
    ]) {
      const text = extractText(await renderInvoicePdf(input));
      expect(text).not.toContain("Terms");
      expect(text).toContain("31 Dec 2026");
    }
  });
});

describe("invoice PDF content", () => {
  it.each(INVOICE_FIXTURES.map((f) => [f.id, f] as const))(
    "fixture (%s) prints the amount due in its own currency and language",
    async (_id, fixture) => {
      const text = extractText(await renderInvoicePdf(inputFor(fixture.id)));
      const money = (cents: number) =>
        formatMoney(cents, fixture.client.pdfLanguage, fixture.currency).replaceAll("\u00a0", " ");
      expect(text).toContain(money(fixture.expected.amountDueCents));
      if (fixture.ritenuta) expect(text).toContain(money(fixture.expected.ritenutaCents));
      if (fixture.naturaText) expect(text).toContain(fixture.naturaText);
    },
  );
});

describe("invoice PDF ritenuta base", () => {
  it("states the share of the taxable only when it is not 100%", async () => {
    const partial = extractText(await renderInvoicePdf(inputFor("h")));
    // Fixture (h): 20% on 10% of 1,000.00, base 100.00, withheld 20.00.
    expect(partial).toContain("Ritenuta d'acconto 20% su 10% di 1000,00");
    expect(partial).toContain("(100,00");
    const whole = extractText(await renderInvoicePdf(inputFor("a")));
    expect(whole).not.toContain("% di ");
    expect(whole).toMatch(/Ritenuta d'acconto 20% su \d{4},\d{2}/);
  });
});

describe("invoice PDF line notes", () => {
  it("prints the note under the line description", async () => {
    const input = inputFor("b");
    const lines = input.invoice.lines.map((line, index) =>
      index === 0 ? { ...line, note: "Phase one, delivered in March" } : line,
    );
    const text = extractText(
      await renderInvoicePdf({ ...input, invoice: { ...input.invoice, lines } }),
    );
    expect(text).toContain("Phase one, delivered in March");
    const without = extractText(await renderInvoicePdf(input));
    expect(without).not.toContain("Phase one");
  });
});

describe("invoice PDF note", () => {
  it("prints the invoice note in a notes block, and nothing without one", async () => {
    const input = inputFor("b");
    const data = { ...input.invoice.data, note: "Payment by bank transfer only.\nThank you." };
    const text = extractText(
      await renderInvoicePdf({ ...input, invoice: { ...input.invoice, data } }),
    );
    expect(text).toContain("Note");
    expect(text).toContain("Payment by bank transfer only.");
    expect(text).toContain("Thank you.");
    expect(extractText(await renderInvoicePdf(input))).not.toContain("Thank you.");
  });
});

describe("invoice PDF contribution and ritenuta breakdown", () => {
  it("lists the subject amount of a ritenuta that includes the rivalsa (fixture i)", async () => {
    const text = extractText(await renderInvoicePdf(inputFor("i")));
    // 20% on 10% of 1,040.00 (rivalsa subject to ritenuta), base 104.00.
    expect(text).toContain("Ritenuta d'acconto 20% su 10% di 1040,00");
    expect(text).toContain("(104,00");
    expect(text).toContain("20,80");
  });

  it("shows the taxable amount without the contribution, the contribution and their sum when included (fixture f1)", async () => {
    const text = extractText(await renderInvoicePdf(inputFor("f1")));
    expect(text).toContain("Imponibile senza contributo");
    expect(text).toContain("1000,00");
    expect(text).toMatch(/4%/);
    expect(text).toContain("40,00");
    expect(text).toContain("Totale imponibile");
    expect(text).toContain("1040,00");
  });

  it("only names the contribution with its percentage when added on top (fixture a)", async () => {
    const text = extractText(await renderInvoicePdf(inputFor("a")));
    expect(text).toContain("Rivalsa INPS 4% (aggiunta agli importi sopra)");
    expect(text).not.toContain("Imponibile senza contributo");
  });
});
