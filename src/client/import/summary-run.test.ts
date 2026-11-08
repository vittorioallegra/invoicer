// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SummaryImportResponse } from "../../shared/import";
import type { FicSummary } from "./fic-summary";
import { runSummaryImport } from "./summary-run";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api: mocks.api }));

const issued = (n: number) => ({
  line: n,
  row: {
    documentType: "TD01" as const,
    number: `${n}/CH`,
    date: "2025-03-31",
    currency: "EUR",
    totalCents: 100,
    customer: { name: `Client ${n}`, vatCountry: null, vatCode: null, taxCode: null },
    amounts: {
      taxableCents: 100,
      taxCents: 0,
      withholdingCents: 0,
      rivalsaCents: 0,
      cassaCents: 0,
      otherCassaCents: 0,
    },
  },
});
const receivedRow = (n: number) => ({
  line: 100 + n,
  row: {
    supplierName: `Supplier ${n}`,
    supplierVat: null,
    number: String(n),
    issueDate: "2024-01-05",
    documentType: "TD01",
    currency: "EUR",
    totalCents: 100,
  },
});

const options = {
  markPaid: true,
  today: "2025-06-01",
  series: [{ name: "CH", prefix: null, suffix: "/CH" }],
  label: (kind: string, number: string, date: string, name: string) =>
    `${kind} ${number} ${date} ${name}`,
  invalidLabel: (row: { line: number }) => `row ${row.line}`,
  invalidDetail: (row: { field: string }) => row.field,
};

beforeEach(() => {
  mocks.api.mockReset();
});

describe("runSummaryImport", () => {
  it("creates the series, then sends the rows in chunks and reports progress", async () => {
    mocks.api.mockImplementation(async (path: string, init: { body: string }) => {
      if (path === "/api/numbering-series") return {};
      const { rows } = JSON.parse(init.body) as { rows: unknown[] };
      return {
        results: rows.map((_, i) =>
          i === 0 && path.includes("invoices")
            ? { outcome: "duplicate", id: "old" }
            : { outcome: "imported", id: "new" },
        ),
      } satisfies SummaryImportResponse;
    });
    const summary: FicSummary = {
      issued: Array.from({ length: 45 }, (_, i) => issued(i + 1)),
      received: [receivedRow(1)],
      invalid: [{ line: 9, kind: "issued", field: "date" }],
    };
    const progress: number[] = [];
    const items = await runSummaryImport(summary, {
      ...options,
      onProgress: (p) => progress.push(p.done),
    });
    const paths = mocks.api.mock.calls.map((call) => call[0]);
    expect(paths).toEqual([
      "/api/numbering-series",
      "/api/invoices/import-summary",
      "/api/invoices/import-summary",
      "/api/invoices/import-summary",
      "/api/received/import-summary",
    ]);
    const sent = JSON.parse(mocks.api.mock.calls[1]?.[1].body as string).rows;
    expect(sent).toHaveLength(20);
    expect(sent[0]).toMatchObject({ number: "1/CH", paid: true });
    expect(sent[0]).not.toHaveProperty("amounts");
    expect(progress).toEqual([0, 20, 40, 45, 46]);
    expect(items).toHaveLength(47);
    expect(items[0]).toMatchObject({
      kind: "issued",
      label: "issued 1/CH 2025-03-31 Client 1",
      status: "skipped",
      reason: "duplicate",
      id: "old",
    });
    expect(items[1]).toMatchObject({ status: "imported", id: "new" });
    expect(items.at(-1)).toMatchObject({
      status: "skipped",
      reason: "invalid_row",
      detail: "date",
    });
  });

  it("marks the rows of a failed chunk and goes on", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path.includes("invoices")) throw new Error("network");
      return { results: [{ outcome: "imported", id: "r1" }] };
    });
    const items = await runSummaryImport(
      { issued: [issued(1)], received: [receivedRow(1)], invalid: [] },
      { ...options, series: [], markPaid: false },
    );
    expect(items.map((item) => [item.kind, item.status, item.reason])).toEqual([
      ["issued", "skipped", "server_error"],
      ["received", "imported", undefined],
    ]);
    expect(JSON.parse(mocks.api.mock.calls[1]?.[1].body as string).rows[0].paid).toBe(false);
  });

  it("sends the rows dated after today to the drafts endpoint, ten at a time, unpaid", async () => {
    mocks.api.mockImplementation(async (path: string, init: { body: string }) => {
      if (path === "/api/numbering-series") return {};
      const { rows } = JSON.parse(init.body) as { rows: unknown[] };
      return {
        results: rows.map((_, i) =>
          path.endsWith("-drafts") && i === 0
            ? { outcome: "imported", id: "d1", numberNote: "unavailable" }
            : path.endsWith("-drafts") && i === 1
              ? { outcome: "number_conflict", id: "c1", number: "2/CH" }
              : { outcome: "imported", id: "new" },
        ),
      } satisfies SummaryImportResponse;
    });
    const later = (n: number) => ({ line: n, row: { ...issued(n).row, date: "2025-12-31" } });
    const items = await runSummaryImport(
      {
        issued: [issued(1), ...Array.from({ length: 12 }, (_, i) => later(i + 2))],
        received: [],
        invalid: [],
      },
      { ...options, series: [] },
    );
    const paths = mocks.api.mock.calls.map((call) => call[0]);
    expect(paths).toEqual([
      "/api/invoices/import-summary",
      "/api/invoices/import-summary-drafts",
      "/api/invoices/import-summary-drafts",
    ]);
    const drafts = JSON.parse(mocks.api.mock.calls[1]?.[1].body as string).rows;
    expect(drafts).toHaveLength(10);
    expect(drafts[0]).toMatchObject({ number: "2/CH", amounts: { taxableCents: 100 } });
    expect(drafts[0]).not.toHaveProperty("paid");
    expect(items[0]).not.toHaveProperty("draft");
    expect(items[1]).toMatchObject({
      status: "imported",
      id: "d1",
      draft: true,
      detail: "draft_number_unavailable",
    });
    expect(items[2]).toMatchObject({ status: "skipped", reason: "number_conflict", id: "c1" });
  });
});
