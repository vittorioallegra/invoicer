// @vitest-environment node
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { fixtureToFatturaInput } from "../../shared/fixtures/fatturapa";
import { INVOICE_FIXTURES } from "../../shared/fixtures/invoices";
import { formatMoney } from "../../shared/format";
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
    terms: { days: 0 | 30 | 60 | 90 | 120; basis: "invoice_date" | "end_of_month" } | null,
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
    const it = extractText(
      await renderInvoicePdf(withTerms("b", { days: 30, basis: "end_of_month" })),
    );
    expect(it).toContain("30 gg fine mese data fattura");
    expect(it).toContain("31 dic 2026");
    const en = extractText(
      await renderInvoicePdf(withTerms("c", { days: 30, basis: "end_of_month" })),
    );
    expect(en).toContain("30 days end of month");
    expect(en).toContain("31 Dec 2026");
    const df = extractText(
      await renderInvoicePdf(withTerms("c", { days: 60, basis: "invoice_date" })),
    );
    expect(df).toContain("60 days from invoice date");
  });

  it("prints only the due date without terms or with a custom date", async () => {
    for (const input of [
      withTerms("c", null),
      withTerms("c", { days: 30, basis: "invoice_date" }, true),
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
