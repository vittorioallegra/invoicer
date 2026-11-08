// @vitest-environment node
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_META_HEADER, type IssuedImportMeta } from "../../shared/import";
import { type ImportOptions, runInvoiceImport } from "./run";
import { testLine, testXml } from "./test-xml";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api: mocks.api }));

const p7m = new Uint8Array(
  readFileSync(new URL("./fixtures/IT01234567890_FPR01.xml.p7m", import.meta.url)),
);
const bytes = (text: string) => new TextEncoder().encode(text);
const issued = (number: string, date = "2025-03-31") => bytes(testXml({ number, date }));
const received = (number: string) =>
  bytes(testXml({ supplierVat: "05555555555", number, date: "2024-01-05" }));
const metaOf = (call: unknown[]): IssuedImportMeta => {
  const init = call[1] as { headers: Record<string, string> };
  return JSON.parse(decodeURIComponent(init.headers[IMPORT_META_HEADER] ?? "")) as IssuedImportMeta;
};
const pick = (name: string, content: Uint8Array) => ({ name, read: async () => content });
const options: ImportOptions = {
  markPaid: true,
  ownVat: "IT01234567890",
  today: "2025-06-01",
  series: [],
  label: (kind, number, date, name) => `${kind} ${number} ${date} ${name}`,
};
const pathsCalled = () => mocks.api.mock.calls.map((call) => call[0]);

beforeEach(() => {
  mocks.api.mockReset();
  let n = 0;
  mocks.api.mockImplementation(async (path: string) =>
    path === "/api/numbering-series"
      ? {}
      : { outcome: "imported", id: `i${++n}`, clientLinked: true },
  );
});

describe("combined invoice file import", () => {
  it("tells issued from received files by the supplier and ignores what is not an invoice", async () => {
    const zip = zipSync({
      "Export/sent/Main/IT01234567890_00001.xml": issued("1"),
      "Export/sent/Main/IT01234567890_00003.xml.p7m": p7m,
      "Export/purchases/IT05555555555_1.xml": received("77"),
      "Export/invoices/1.pdf": bytes("%PDF"),
      "Export/clients list.xlsx": bytes("sheet"),
      "Export/prices.xls": bytes("sheet"),
      "Export/notes.txt": bytes("text"),
      "__MACOSX/Export/._IT01234567890_00001.xml": bytes("meta"),
      "Export/._IT05555555555_1.xml": bytes("meta"),
      "Export/.DS_Store": bytes("meta"),
    });
    const progress: number[] = [];
    const { items } = await runInvoiceImport([pick("export.zip", zip)], {
      ...options,
      onProgress: (p) => progress.push(p.done),
    });
    expect(items.map((item) => [item.label, item.status, item.kind])).toEqual([
      ["issued 1 2025-03-31 Test Customer", "imported", "issued"],
      ["issued 123 2014-12-18 DITTA BETA", "imported", "issued"],
      ["received 77 2024-01-05 Test Supplier", "imported", "received"],
    ]);
    expect(pathsCalled()).toEqual([
      "/api/invoices/import",
      "/api/invoices/import",
      "/api/received/import",
    ]);
    expect(metaOf(mocks.api.mock.calls[0] ?? [])).toMatchObject({
      fileName: "IT01234567890_00001.xml",
      documentType: "TD01",
      number: "1",
      date: "2025-03-31",
      paid: true,
    });
    expect(progress[progress.length - 1]).toBe(3);
  });

  it("applies the paid box to both kinds", async () => {
    await runInvoiceImport([pick("a.xml", issued("1")), pick("b.xml", received("2"))], {
      ...options,
      markPaid: false,
    });
    expect(metaOf(mocks.api.mock.calls[0] ?? [])).toMatchObject({ paid: false });
    const receivedInit = mocks.api.mock.calls[1]?.[1] as { headers: Record<string, string> };
    const receivedMeta = JSON.parse(
      decodeURIComponent(receivedInit.headers[IMPORT_META_HEADER] ?? ""),
    );
    expect(receivedMeta.paid).toBe(false);
  });

  it("creates invoices to send from the real lines of unsent files, after the issued ones", async () => {
    const draftXml = (number: string, date: string) =>
      bytes(
        testXml({
          number,
          date,
          lines: testLine(1, "First work", "40.00") + testLine(2, "Second work", "60.00"),
        }),
      );
    const zip = zipSync({
      "Export/fatture elettroniche non inviate/12_dicembre/IT_1.xml": draftXml("12", "2025-12-31"),
      "Export/fatture elettroniche non inviate/11_novembre/IT_0.xml": draftXml("11", "2025-05-30"),
      "Export/fatture elettroniche inviate/03/IT_5.xml": issued("5"),
    });
    mocks.api.mockImplementation(async (path: string, init: { body?: string }) => {
      if (path === "/api/invoices/import-draft") {
        return JSON.parse(init.body ?? "{}").number === "12"
          ? { outcome: "imported", id: "d2", numberNote: "unavailable" }
          : { outcome: "imported", id: "d1" };
      }
      return { outcome: "imported", id: "i1", clientLinked: true };
    });
    const { items } = await runInvoiceImport([pick("export.zip", zip)], options);
    expect(pathsCalled()).toEqual([
      "/api/invoices/import",
      "/api/invoices/import-draft",
      "/api/invoices/import-draft",
    ]);
    expect(items.map((item) => [item.label, item.draft ?? false, item.detail])).toEqual([
      ["issued 5 2025-03-31 Test Customer", false, undefined],
      ["issued 11 2025-05-30 Test Customer", true, undefined],
      ["issued 12 2025-12-31 Test Customer", true, "draft_number_unavailable"],
    ]);
    const draftInit = mocks.api.mock.calls[1]?.[1] as { body: string };
    const body = JSON.parse(draftInit.body) as {
      lines: { description: string; unitPriceCents: number }[];
      number: string;
    };
    expect(body.number).toBe("11");
    expect(body.lines.map((line) => [line.description, line.unitPriceCents])).toEqual([
      ["First work", 4000],
      ["Second work", 6000],
    ]);
  });

  it("treats an issued invoice dated after today as not sent, even outside a not-sent folder", async () => {
    const { items } = await runInvoiceImport(
      [pick("future.xml", issued("9", "2025-06-02"))],
      options,
    );
    expect(pathsCalled()).toEqual(["/api/invoices/import-draft"]);
    expect(items[0]).toMatchObject({ status: "imported", draft: true });
  });

  it("creates the numbering series that suffixed numbers need, once", async () => {
    const { createdSeries } = await runInvoiceImport(
      [pick("a.xml", issued("5/CH")), pick("b.xml", issued("6/CH")), pick("c.xml", issued("7"))],
      options,
    );
    expect(createdSeries).toMatchObject([{ name: "CH", suffix: "/CH" }]);
    const created = mocks.api.mock.calls.filter((call) => call[0] === "/api/numbering-series");
    expect(created).toHaveLength(1);
    // The series exist before the first invoice is sent.
    expect(pathsCalled()[0]).toBe("/api/numbering-series");

    mocks.api.mockClear();
    const again = await runInvoiceImport([pick("a.xml", issued("5/CH"))], {
      ...options,
      series: [{ id: "s1", name: "CH", prefix: null, suffix: "/CH", isDefault: false } as never],
    });
    expect(again.createdSeries).toEqual([]);
    expect(pathsCalled()).toEqual(["/api/invoices/import"]);
  });

  it("skips what cannot be imported with a reason and keeps going", async () => {
    mocks.api.mockImplementation(async (_path: string, init: { body: Uint8Array }) => {
      const text = new TextDecoder().decode(init.body);
      if (text.includes("<Numero>2</Numero>")) return { outcome: "duplicate", id: "old" };
      if (text.includes("<Numero>3</Numero>")) {
        return { outcome: "number_conflict", id: "taken", number: "3" };
      }
      if (text.includes("<Numero>4</Numero>")) {
        throw Object.assign(new Error("too big"), { status: 413 });
      }
      return { outcome: "imported", id: "new", clientLinked: false };
    });
    const { items } = await runInvoiceImport(
      [
        pick("1.xml", issued("1")),
        pick("2.xml", issued("2")),
        pick("3.xml", issued("3")),
        pick("4.xml", issued("4")),
        pick("bad.xml", bytes("hello")),
        pick("td02.xml", bytes(testXml({ type: "TD02", number: "8" }))),
      ],
      { ...options, label: undefined },
    );
    expect(items).toMatchObject([
      { label: "1.xml", status: "imported", detail: "no_client" },
      { label: "2.xml", status: "skipped", reason: "duplicate", id: "old" },
      { label: "3.xml", status: "skipped", reason: "number_conflict", detail: "3" },
      { label: "4.xml", status: "skipped", reason: "too_large" },
      { label: "bad.xml", status: "skipped", reason: "unreadable" },
      { label: "td02.xml", status: "skipped", reason: "unsupported_document_type", detail: "TD02" },
    ]);
  });

  it("reports an archive with no invoice file", async () => {
    const zip = zipSync({ "a.pdf": bytes("%PDF"), "__MACOSX/b.xml": bytes("x") });
    const { items } = await runInvoiceImport([pick("only-pdf.zip", zip)], options);
    expect(items).toMatchObject([
      { label: "only-pdf.zip", status: "skipped", reason: "empty_archive" },
    ]);
    expect(mocks.api).not.toHaveBeenCalled();
  });
});
