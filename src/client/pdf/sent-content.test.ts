// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type ClientRecord, EMPTY_CLIENT_DEFAULTS } from "../../shared/client";
import { buildFatturaXml } from "../../shared/fatturapa";
import { fixtureToFatturaInput } from "../../shared/fixtures/fatturapa";
import { INVOICE_FIXTURES } from "../../shared/fixtures/invoices";
import { formatMoney } from "../../shared/format";
import type { InvoiceRecord } from "../../shared/invoice";
import { invoicePdfFileName } from "../../shared/pdf-name";
import { extractText } from "./pdf-text";
import { renderInvoicePdf } from "./render";
import { pdfInputFromSentXml, SentContentError } from "./sent-content";

/** A sent invoice of a fixture: its XML, the invoice record and the client record as stored. */
function sent(id: string) {
  const fixture = INVOICE_FIXTURES.find((f) => f.id === id);
  if (!fixture) throw new Error(`fixture ${id}`);
  const input = fixtureToFatturaInput(fixture, 7);
  const { xml, totals } = buildFatturaXml(input);
  const invoice = {
    id: "i1",
    ...input.invoice,
    number: input.number,
    issueDate: input.issueDate,
    linked: input.linked ?? null,
    clientId: "c1",
  } as unknown as InvoiceRecord;
  const client: ClientRecord = {
    ...input.client,
    id: "c1",
    email: null,
    pdfLanguage: fixture.client.pdfLanguage,
    currency: fixture.currency,
    defaults: EMPTY_CLIENT_DEFAULTS,
  };
  return { xml, invoice, client, totals, fixture };
}

describe("PDF input from the sent XML", () => {
  it.each(INVOICE_FIXTURES.map((f) => f.id))(
    "fixture %s: rebuilds the XML exactly and prints its parties, lines and totals",
    async (id) => {
      const { xml, invoice, client, totals, fixture } = sent(id);
      const input = pdfInputFromSentXml(xml, invoice, client);
      expect(input.client.name).toBe(client.name);
      expect(input.issuer.name).toBe("Studio Example");
      expect(input.language).toBe(fixture.client.pdfLanguage);
      const text = extractText(await renderInvoicePdf(input));
      expect(text).toContain(client.name);
      expect(text).toContain("Studio Example");
      for (const line of invoice.lines) expect(text).toContain(line.description);
      const flat = (value: string) => value.replace(/[\s\u00a0\u202f]+/g, " ");
      expect(flat(text)).toContain(
        flat(formatMoney(totals.amountDueCents, input.language, invoice.currency)),
      );
    },
  );

  it("prints the issuer contacts parsed from the XML, and rebuilds an old XML without them", async () => {
    const fixture = INVOICE_FIXTURES.find((f) => f.id === "b");
    if (!fixture) throw new Error("fixture b");
    const base = sent("b");
    const plain = extractText(
      await renderInvoicePdf(pdfInputFromSentXml(base.xml, base.invoice, base.client)),
    );
    expect(plain).not.toContain("Email:");
    expect(plain).not.toContain("Tel.:");

    const input = fixtureToFatturaInput(fixture, 7);
    const issuer = { ...input.issuer, email: "info@studio.it", phone: "+39 366 593 1825" };
    const { xml } = buildFatturaXml({ ...input, issuer });
    const pdf = pdfInputFromSentXml(xml, base.invoice, base.client);
    expect(pdf.issuer).toMatchObject({ email: "info@studio.it", phone: "393665931825" });
    expect(extractText(await renderInvoicePdf(pdf))).toContain("Tel.: 393665931825");
    // While the profile still holds the number that was sent, it prints as typed.
    const typed = pdfInputFromSentXml(xml, base.invoice, base.client, "+39 366 593 1825");
    const text = extractText(await renderInvoicePdf(typed));
    expect(text).toContain("Email: info@studio.it");
    expect(text).toContain("Tel.: +39 366 593 1825");
    // A number changed since falls back to the XML value.
    const changed = pdfInputFromSentXml(xml, base.invoice, base.client, "06 1234567");
    expect(changed.issuer.phone).toBe("393665931825");
  });

  it("ignores a client renamed after the invoice was sent", async () => {
    const { xml, invoice, client } = sent("b");
    const renamed = { ...client, name: "Renamed Holding Ltd", address: "Via Nuova 99" };
    const input = pdfInputFromSentXml(xml, invoice, renamed);
    expect(input.client.name).toBe(client.name);
    expect(input.client.address).toBe(client.address);
    const text = extractText(await renderInvoicePdf(input));
    expect(text).toContain(client.name);
    expect(text).not.toContain("Renamed Holding");
    expect(text).not.toContain("Via Nuova 99");
    expect(invoicePdfFileName("2", input.client.name)).toBe(invoicePdfFileName("2", client.name));
  });

  it("refuses an invoice edited after the XML was sent", () => {
    const { xml, invoice, client } = sent("b");
    const line = invoice.lines[0];
    if (!line) throw new Error("no line");
    const edited = { ...invoice, lines: [{ ...line, description: "Changed later" }] };
    expect(() => pdfInputFromSentXml(xml, edited, client)).toThrow(SentContentError);
  });

  it("refuses text that is not a FatturaPA", () => {
    const { invoice, client } = sent("a");
    expect(() => pdfInputFromSentXml("<nope/>", invoice, client)).toThrow(SentContentError);
  });
});
