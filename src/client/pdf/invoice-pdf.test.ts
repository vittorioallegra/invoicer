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
  return extractPages(pdf).join("\n");
}

/** The text of each page content stream, in page order. */
function extractPages(pdf: Uint8Array): string[] {
  const raw = Buffer.from(pdf).toString("latin1");
  const pages: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(match[1] ?? "", "latin1")).toString("latin1");
    } catch {
      continue;
    }
    const parts: string[] = [];
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
    if (parts.length > 0) pages.push(parts.join("\n").replaceAll(" ", " "));
  }
  return pages;
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

describe("invoice PDF layout", () => {
  it("labels the parties From/To (Mittente/Destinatario) and drops the regime, currency and VAT summary", async () => {
    const en = extractText(await renderInvoicePdf(inputFor("c")));
    // The labels are printed in capitals.
    expect(en).toMatch(/^FROM$/m);
    expect(en).toMatch(/^TO$/m);
    for (const gone of ["Billed to", "Tax regime", "Currency", "VAT summary"]) {
      expect(en).not.toContain(gone);
    }
    const it = extractText(await renderInvoicePdf(inputFor("b")));
    expect(it).toMatch(/^MITTENTE$/m);
    expect(it).toMatch(/^DESTINATARIO$/m);
    for (const gone of ["cedente", "cessionario", "regime fiscale", "valuta", "riepilogo iva"]) {
      expect(it.toLowerCase()).not.toContain(gone);
    }
  });

  it("prints the due date once, in the payment block, and no amount line there", async () => {
    const text = extractText(await renderInvoicePdf(inputFor("c")));
    expect(text.match(/20 May 2026/g)).toHaveLength(1);
    expect(text).not.toMatch(/Amount: /);
    expect(text.match(/Due date/g)).toHaveLength(1);
  });

  it("anchors payment and totals to the bottom of the last page only on a long invoice", async () => {
    const input = inputFor("b");
    const base = input.invoice.lines[0];
    if (!base) throw new Error("fixture b has no line");
    const lines = Array.from({ length: 60 }, (_, i) => ({
      ...base,
      description: `Line ${i + 1} description`,
    }));
    const pages = extractPages(
      await renderInvoicePdf({ ...input, invoice: { ...input.invoice, lines } }),
    );
    expect(pages.length).toBeGreaterThanOrEqual(2);
    const last = pages[pages.length - 1] ?? "";
    expect(last).toContain("IT60X0542811101000000123456");
    expect(last).toContain("Importo dovuto");
    for (const page of pages.slice(0, -1)) {
      expect(page).not.toContain("IT60X0542811101000000123456");
      expect(page).not.toContain("Importo dovuto");
    }
    expect(pages[0]).toContain("Line 1 description");
  });
});

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

  it("prints the bollo charged to the client as a line, and nothing when the issuer bears it", async () => {
    const client = extractText(await renderInvoicePdf(inputFor("b")));
    expect(client).toContain("Imposta di bollo");
    expect(client).toContain("927,10");
    const issuer = extractText(await renderInvoicePdf(inputFor("k")));
    expect(issuer).not.toContain("Imposta di bollo");
    expect(issuer).toContain("925,10");
    // A stored invoice keeps the old summary row with the 2.00 in the total.
    const legacy = extractText(await renderInvoicePdf(inputFor("l")));
    expect(legacy).toContain("Imposta di bollo");
    expect(legacy).toContain("927,10");
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
  const withTerms = (id: string, terms: PaymentTerms | null): InvoicePdfInput => {
    const input = inputFor(id);
    return {
      ...input,
      invoice: {
        ...input.invoice,
        dueDate: "2026-12-31",
        data: {
          ...input.invoice.data,
          payment: { ...input.invoice.data.payment, terms },
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

  it("prints only the due date without terms", async () => {
    const text = extractText(await renderInvoicePdf(withTerms("c", null)));
    expect(text).not.toContain("Terms");
    expect(text).toContain("31 Dec 2026");
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
    expect(partial).toContain("Ritenuta d'acconto 20% su 10% di 1.000,00");
    expect(partial).toContain("(100,00");
    const whole = extractText(await renderInvoicePdf(inputFor("a")));
    expect(whole).not.toContain("% di ");
    expect(whole).toMatch(/Ritenuta d'acconto 20% su \d\.\d{3},\d{2}/);
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
    expect(text).toContain("Ritenuta d'acconto 20% su 10% di 1.040,00");
    expect(text).toContain("(104,00");
    expect(text).toContain("20,80");
  });

  it("shows the taxable amount without the contribution, the contribution and their sum when included (fixture f1)", async () => {
    const text = extractText(await renderInvoicePdf(inputFor("f1")));
    expect(text).toContain("Imponibile senza contributo");
    expect(text).toContain("1.000,00");
    expect(text).toMatch(/4%/);
    expect(text).toContain("40,00");
    expect(text).toContain("Totale imponibile");
    expect(text).toContain("1.040,00");
  });

  it("shows the lines' taxable, the added contribution and their sum (fixture a)", async () => {
    const text = extractText(await renderInvoicePdf(inputFor("a")));
    // 1,200.00 + 489.75 = 1,689.75; 4% = 67.59; sum 1,757.34.
    expect(text).toContain("Imponibile senza contributo");
    expect(text).toContain("1.689,75");
    expect(text).toContain("Rivalsa INPS 4%");
    expect(text).not.toContain("aggiunta agli importi");
    expect(text).toContain("Totale imponibile");
    expect(text).toContain("1.757,34");
  });

  it("always prints the taxable amount, also without a contribution (fixture b)", async () => {
    expect(extractText(await renderInvoicePdf(inputFor("b")))).toContain("Totale imponibile");
  });
});
