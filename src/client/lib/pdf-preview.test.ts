import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewPdf } from "./pdf-preview";

const bytes = new Uint8Array([37, 80, 68, 70]);

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:pdf");
});
afterEach(() => vi.restoreAllMocks());

describe("previewPdf", () => {
  it("opens the tab before rendering and points it at the PDF", async () => {
    const tab = { closed: false, close: vi.fn(), location: { href: "" } };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    let openedBeforeRender = false;
    const result = await previewPdf(async () => {
      openedBeforeRender = open.mock.calls.length === 1;
      return bytes;
    }, "x.pdf");
    expect(openedBeforeRender).toBe(true);
    expect(tab.location.href).toBe("blob:pdf");
    expect(result).toEqual({ url: "blob:pdf", opened: true });
  });

  it("downloads the file when the browser blocks the tab", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(`${this.download}|${this.href}`);
    });
    const result = await previewPdf(async () => bytes, "invoice.pdf");
    expect(clicked).toEqual(["invoice.pdf|blob:pdf"]);
    expect(result.opened).toBe(false);
  });

  it("closes the blank tab when rendering fails", async () => {
    const tab = { closed: false, close: vi.fn(), location: { href: "" } };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    await expect(
      previewPdf(async () => {
        throw new Error("render");
      }, "x.pdf"),
    ).rejects.toThrow("render");
    expect(tab.close).toHaveBeenCalled();
  });
});
