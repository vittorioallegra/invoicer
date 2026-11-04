// @vitest-environment node
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseFatturaXml } from "../../shared/fatturapa";
import { extractP7m, P7mError } from "./p7m";
import { readImportFile } from "./read";
import { documentTotalCents, summarizeInvoice } from "./summary";

const xmlPath = new URL("../../shared/fatturapa/fixtures/IT01234567890_FPR01.xml", import.meta.url);
const p7mPath = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const xml = new Uint8Array(readFileSync(xmlPath));
const p7m = new Uint8Array(readFileSync(p7mPath("IT01234567890_FPR01.xml.p7m")));
const streamed = new Uint8Array(readFileSync(p7mPath("IT01234567890_FPR01_stream.xml.p7m")));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("P7M extraction", () => {
  it("returns the signed XML of a DER file", () => {
    expect(text(extractP7m(p7m))).toBe(text(xml));
  });

  it("joins the chunks of a streamed (indefinite length BER) file", () => {
    expect(text(extractP7m(streamed))).toBe(text(xml));
  });

  it("reads a base64 file, with PEM lines too", () => {
    const base64 = Buffer.from(p7m).toString("base64");
    expect(text(extractP7m(new TextEncoder().encode(base64)))).toBe(text(xml));
    const pem = `-----BEGIN PKCS7-----\n${base64.replace(/(.{64})/g, "$1\n")}\n-----END PKCS7-----\n`;
    expect(text(extractP7m(new TextEncoder().encode(pem)))).toBe(text(xml));
  });

  it("rejects what is not a P7M", () => {
    expect(() => extractP7m(new Uint8Array([1, 2, 3]))).toThrow(P7mError);
    expect(() => extractP7m(xml)).toThrow(P7mError);
  });
});

describe("invoice file reading", () => {
  it("reads a plain XML and a P7M to the same invoice", () => {
    const [plain] = readImportFile("a.xml", xml);
    const [signed] = readImportFile("a.xml.p7m", p7m);
    expect(plain?.reason).toBeNull();
    expect(signed?.reason).toBeNull();
    expect(signed?.invoice).toEqual(plain?.invoice);
    // The stored original of a P7M keeps its signature.
    expect(signed?.original).toBe(p7m);
  });

  it("reads every invoice of a ZIP and ignores the SdI side files", () => {
    const zip = zipSync({
      "invoices/IT01234567890_00001.xml": xml,
      "invoices/IT01234567890_00002.xml.p7m": p7m,
      "invoices/IT01234567890_00002_MT_001.xml": new TextEncoder().encode("<Metadati/>"),
      "invoices/notes.xml": new TextEncoder().encode("<notes/>"),
      "__MACOSX/._x": new Uint8Array([1]),
    });
    const files = readImportFile("export.zip", zip);
    expect(files.map((f) => [f.label, f.reason])).toEqual([
      ["export.zip/IT01234567890_00001.xml", null],
      ["export.zip/IT01234567890_00002.xml.p7m", null],
      ["export.zip/notes.xml", "unreadable"],
    ]);
  });

  it("flags a file that is not an invoice, an empty archive and a too large file", () => {
    expect(readImportFile("x.xml", new TextEncoder().encode("hello"))[0]?.reason).toBe(
      "unreadable",
    );
    expect(readImportFile("x.p7m", new Uint8Array([0x30, 0x03, 1, 2, 3]))[0]?.reason).toBe(
      "unreadable",
    );
    expect(readImportFile("e.zip", zipSync({ "a_RC_001.xml": xml }))[0]?.reason).toBe(
      "empty_archive",
    );
    expect(readImportFile("big.xml", new Uint8Array(2 * 1024 * 1024 + 1))[0]?.reason).toBe(
      "too_large",
    );
  });

  it("honours a non-UTF-8 encoding declaration", () => {
    const latin1 = Buffer.from(
      text(xml)
        .replace(/encoding="UTF-8"/, 'encoding="ISO-8859-1"')
        .replace("ALPHA SRL", "ALPHÀ SRL"),
      "latin1",
    );
    const [file] = readImportFile("l.xml", new Uint8Array(latin1));
    expect(file?.invoice?.supplier.name).toBe("SOCIETA' ALPHÀ SRL");
  });
});

describe("invoice summary", () => {
  it("summarises the first document", () => {
    const invoice = parseFatturaXml(text(xml));
    expect(summarizeInvoice(invoice)).toMatchObject({
      supplierName: "SOCIETA' ALPHA SRL",
      supplierVat: "IT01234567890",
      documentType: "TD01",
      currency: "EUR",
    });
  });

  it("falls back to the VAT summary when the file has no total", () => {
    const invoice = parseFatturaXml(text(xml));
    const document = { ...(invoice.documents[0] as NonNullable<(typeof invoice.documents)[0]>) };
    document.total = null;
    document.vatSummary = [
      { vatRate: "22.00", natura: null, taxable: "100.00", vat: "22.00", reference: null },
      { vatRate: "0.00", natura: "N4", taxable: "10.005", vat: "0.00", reference: null },
    ];
    expect(documentTotalCents(document)).toBe(13201);
    document.total = "1234.5";
    expect(documentTotalCents(document)).toBe(123450);
  });
});
