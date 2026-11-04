// @vitest-environment node
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_META_HEADER, type IssuedImportMeta } from "../../shared/import";
import { runInvoiceImport } from "./run";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api: mocks.api }));

const xml = readFileSync(
  new URL("../../shared/fatturapa/fixtures/IT01234567890_FPR01.xml", import.meta.url),
  "utf8",
);
const p7m = new Uint8Array(
  readFileSync(new URL("./fixtures/IT01234567890_FPR01.xml.p7m", import.meta.url)),
);
const withNumber = (n: number) =>
  new TextEncoder().encode(xml.replace("<Numero>123</Numero>", `<Numero>${n}</Numero>`));
const metaOf = (call: unknown[]): IssuedImportMeta => {
  const init = call[1] as { headers: Record<string, string> };
  return JSON.parse(decodeURIComponent(init.headers[IMPORT_META_HEADER] ?? "")) as IssuedImportMeta;
};
const pick = (name: string, bytes: Uint8Array) => ({ name, read: async () => bytes });
const OWN = "IT01234567890";

beforeEach(() => {
  mocks.api.mockReset();
});

describe("invoice file import", () => {
  it("imports every invoice of a ZIP of issued invoices and reports progress (AC 17)", async () => {
    let n = 0;
    mocks.api.mockImplementation(async () => ({
      outcome: "imported",
      id: `i${++n}`,
      clientLinked: true,
    }));
    const zip = zipSync({
      "a/IT01234567890_00001.xml": withNumber(1),
      "a/IT01234567890_00002.xml": withNumber(2),
      "a/IT01234567890_00003.xml.p7m": p7m,
    });
    const progress: number[] = [];
    const results = await runInvoiceImport([pick("export.zip", zip)], {
      kind: "issued",
      markPaid: true,
      ownVat: OWN,
      onProgress: (p) => progress.push(p.done),
    });
    expect(results.map((r) => r.status)).toEqual(["imported", "imported", "imported"]);
    expect(mocks.api).toHaveBeenCalledTimes(3);
    for (const call of mocks.api.mock.calls) expect(call[0]).toBe("/api/invoices/import");
    expect(metaOf(mocks.api.mock.calls[0] ?? [])).toMatchObject({
      fileName: "IT01234567890_00001.xml",
      documentType: "TD01",
      number: "1",
      date: "2014-12-18",
      totalCents: 610,
      currency: "EUR",
      paid: true,
      customer: { name: "DITTA BETA", vatCode: null, taxCode: "09876543210" },
    });
    // The signed file is stored as it is (with its signature), read through its content.
    expect(metaOf(mocks.api.mock.calls[2] ?? [])).toMatchObject({
      fileName: "IT01234567890_00003.xml.p7m",
      number: "123",
    });
    expect(progress[progress.length - 1]).toBe(3);
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
    const results = await runInvoiceImport(
      [
        pick("1.xml", withNumber(1)),
        pick("2.xml", withNumber(2)),
        pick("3.xml", withNumber(3)),
        pick("4.xml", withNumber(4)),
        pick("bad.xml", new TextEncoder().encode("hello")),
        pick("td02.xml", new TextEncoder().encode(xml.replace("TD01", "TD02"))),
        pick(
          "other.xml",
          new TextEncoder().encode(
            xml.replace(/<IdCodice>01234567890<\/IdCodice>/g, "<IdCodice>99999999999</IdCodice>"),
          ),
        ),
      ],
      { kind: "issued", ownVat: OWN },
    );
    expect(results).toEqual([
      { label: "1.xml", status: "imported", id: "new", detail: "no_client" },
      { label: "2.xml", status: "skipped", reason: "duplicate", id: "old" },
      { label: "3.xml", status: "skipped", reason: "number_conflict", detail: "3", id: "taken" },
      { label: "4.xml", status: "skipped", reason: "too_large" },
      { label: "bad.xml", status: "skipped", reason: "unreadable" },
      { label: "td02.xml", status: "skipped", reason: "unsupported_document_type", detail: "TD02" },
      { label: "other.xml", status: "skipped", reason: "not_issued_by_owner" },
    ]);
  });

  it("imports received invoices and refuses one issued by the owner", async () => {
    mocks.api.mockResolvedValue({ outcome: "imported", id: "r1" });
    const supplier = xml.replace(
      /<IdCodice>01234567890<\/IdCodice>/g,
      "<IdCodice>05555555555</IdCodice>",
    );
    const results = await runInvoiceImport(
      [pick("s.xml", new TextEncoder().encode(supplier)), pick("own.xml", withNumber(9))],
      { kind: "received", ownVat: OWN },
    );
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ["imported", undefined],
      ["skipped", "issued_by_owner"],
    ]);
    expect(mocks.api.mock.calls[0]?.[0]).toBe("/api/received/import");
  });
});
