import { describe, expect, it } from "vitest";
import { clientSlug, invoicePdfFileName, previewPdfFileName } from "./pdf-name";

describe("invoicePdfFileName", () => {
  it("joins the number as printed and the client slug", () => {
    expect(invoicePdfFileName("CH-3", "Acme S.r.l.")).toBe("invoice-CH-3-acme-s-r-l.pdf");
    expect(invoicePdfFileName("CH-3", "Acme srl")).toBe("invoice-CH-3-acme-srl.pdf");
  });

  it("replaces characters that are unsafe in file names with a dash", () => {
    expect(invoicePdfFileName("3/CH", "Acme")).toBe("invoice-3-CH-acme.pdf");
    expect(invoicePdfFileName('A\\B:C*D?E"F<G>H|I J', "x")).toBe(
      "invoice-A-B-C-D-E-F-G-H-I-J-x.pdf",
    );
  });

  it("omits the client part when there is no client name", () => {
    expect(invoicePdfFileName("7", null)).toBe("invoice-7.pdf");
    expect(invoicePdfFileName("7", "***")).toBe("invoice-7.pdf");
  });
});

describe("previewPdfFileName", () => {
  it("is preview-<client>.pdf with the client slug", () => {
    expect(previewPdfFileName("Acme S.r.l.")).toBe("preview-acme-s-r-l.pdf");
    expect(previewPdfFileName("Caffè Società")).toBe("preview-caffe-societa.pdf");
  });

  it("omits the client part when there is no client name", () => {
    expect(previewPdfFileName(null)).toBe("preview.pdf");
    expect(previewPdfFileName("***")).toBe("preview.pdf");
  });
});

describe("clientSlug", () => {
  it("strips accents, lowercases and collapses non-alphanumerics", () => {
    expect(clientSlug("  Caffè  Società & Figli!! ")).toBe("caffe-societa-figli");
    expect(clientSlug("Zoë's Café")).toBe("zoe-s-cafe");
  });

  it("limits the length without a trailing dash", () => {
    const slug = clientSlug("Very long client name that keeps going on and on forever");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.startsWith("very-long-client-name")).toBe(true);
  });
});
