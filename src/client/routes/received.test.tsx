import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceivedInvoiceRecord } from "../../shared/received";
import { createI18n } from "../i18n";
import { createAppRouter } from "../router";

const mocks = vi.hoisted(() => ({ api: vi.fn(), apiFile: vi.fn() }));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "1", twoFactorEnabled: true } },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    }),
  },
}));
vi.mock("../lib/api", () => ({ api: mocks.api, apiFile: mocks.apiFile }));

const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(process.cwd(), "src/client/import/fixtures", name)));

const record = (over: Partial<ReceivedInvoiceRecord>): ReceivedInvoiceRecord => ({
  id: "r1",
  parseStatus: "pending",
  supplierName: null,
  supplierVat: null,
  number: null,
  issueDate: null,
  documentType: null,
  currency: "EUR",
  totalCents: null,
  paymentFlag: "unpaid",
  paidDate: null,
  source: "pec",
  receivedAt: 1,
  original: { fileName: "IT01234567890_00001.xml.p7m", kind: "received", size: 5783 },
  ...over,
});

async function renderAt(path: string) {
  const i18n = await createI18n("en");
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.apiFile.mockReset();
});
afterEach(cleanup);

describe("received invoices (AC 10)", () => {
  it("reads a P7M delivered by the mailbox poll and lists supplier, number, date and total of the source XML", async () => {
    mocks.apiFile.mockResolvedValue({
      bytes: fixture("IT01234567890_FPR01.xml.p7m"),
      fileName: null,
    });
    let stored = record({});
    const reported: unknown[] = [];
    mocks.api.mockImplementation(
      async (path: string, init?: { method?: string; body?: string }) => {
        if (path === "/api/received" && !init) return { received: [stored] };
        if (path === "/api/received/r1/parsed" && init?.method === "PUT") {
          const body = JSON.parse(init.body ?? "{}") as { summary: Record<string, unknown> };
          reported.push(body);
          stored = record({ parseStatus: "parsed", ...body.summary });
          return { received: stored };
        }
        throw new Error(`unexpected ${path}`);
      },
    );

    await renderAt("/received");
    expect(await screen.findByText("SOCIETA' ALPHA SRL · No. 123")).toBeTruthy();
    // The same values the source XML carries (taxable 5.00 + VAT 1.10 = 6.10).
    expect(reported).toEqual([
      {
        status: "parsed",
        summary: {
          supplierName: "SOCIETA' ALPHA SRL",
          supplierVat: "IT01234567890",
          number: "123",
          issueDate: "2014-12-18",
          documentType: "TD01",
          currency: "EUR",
          totalCents: 610,
        },
      },
    ]);
    expect(screen.getByText(/€\s?6\.10/)).toBeTruthy();
    expect(screen.getByText(/18\/12\/2014|18 Dec 2014|2014/)).toBeTruthy();
  });

  it("marks a file that is not an invoice as failed instead of retrying", async () => {
    mocks.apiFile.mockResolvedValue({
      bytes: new TextEncoder().encode("not an invoice"),
      fileName: null,
    });
    const reported: unknown[] = [];
    let stored = record({ original: { fileName: "x.xml", kind: "received", size: 14 } });
    mocks.api.mockImplementation(
      async (path: string, init?: { method?: string; body?: string }) => {
        if (path === "/api/received" && !init) return { received: [stored] };
        if (init?.method === "PUT") {
          reported.push(JSON.parse(init.body ?? "{}"));
          stored = { ...stored, parseStatus: "failed" };
          return { received: stored };
        }
        throw new Error(`unexpected ${path}`);
      },
    );
    await renderAt("/received");
    expect(await screen.findByText("This file could not be read")).toBeTruthy();
    await waitFor(() => expect(reported).toEqual([{ status: "failed" }]));
  });

  it("shows the readable invoice and a download of the original", async () => {
    mocks.apiFile.mockResolvedValue({
      bytes: fixture("IT01234567890_FPR01.xml.p7m"),
      fileName: null,
    });
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/api/received/r1") {
        return {
          received: record({
            parseStatus: "parsed",
            supplierName: "SOCIETA' ALPHA SRL",
            number: "123",
            issueDate: "2014-12-18",
            totalCents: 610,
          }),
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    await renderAt("/received/r1");
    expect(await screen.findByText("Supplier")).toBeTruthy();
    expect(await screen.findByText("Download original")).toBeTruthy();
    expect(screen.getAllByText(/SOCIETA' ALPHA SRL/).length).toBeGreaterThan(0);
    expect(screen.getByText("Cash")).toBeTruthy();
  });

  it("explains that an invoice without an original file has none to show and offers no download", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/api/received/r1") {
        return {
          received: record({
            parseStatus: "parsed",
            supplierName: "Tool Shop",
            number: "7",
            issueDate: "2024-01-05",
            totalCents: 12200,
            original: null,
          }),
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    await renderAt("/received/r1");
    expect(await screen.findByText(/has no original file/)).toBeTruthy();
    expect(screen.queryByText("Download original")).toBeNull();
    expect(mocks.apiFile).not.toHaveBeenCalled();
  });
});
