import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  return router;
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

    await renderAt("/received?year=all");
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
    // Once in the row, once in the recap.
    expect(screen.getAllByText(/€\s?6\.10/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/18\/12\/2014|18 Dec 2014/).length).toBeGreaterThan(0);
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
    await renderAt("/received?year=all");
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
    // The customer of a received invoice is always the owner: not shown.
    expect(screen.queryByText("Customer")).toBeNull();
    // The actions are in the "more actions" menu, not spread over the title row.
    expect(screen.queryByRole("button", { name: "Download original" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Edit",
      "Mark as paid",
      "Download original",
    ]);
    expect(screen.getAllByText(/SOCIETA' ALPHA SRL/).length).toBeGreaterThan(0);
    expect(screen.getByText("Cash")).toBeTruthy();
  });

  it("titles the page with the supplier, then number and date, then the chips, and repeats none of it in the body", async () => {
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
            documentType: "TD04",
            source: "import",
            totalCents: 610,
          }),
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    await renderAt("/received/r1");
    const title = await screen.findByRole("heading", { level: 1, name: "SOCIETA' ALPHA SRL" });
    const column = title.parentElement as HTMLElement;
    expect(within(column).getByText(/^No\. 123 · /)).toBeTruthy();
    for (const chip of ["Unpaid", "Imported", "Credit note"]) {
      expect(within(column).getByText(chip)).toBeTruthy();
    }
    expect(
      (column.parentElement as HTMLElement).contains(
        screen.getByRole("button", { name: "More actions" }),
      ),
    ).toBe(true);
    await screen.findByText("Supplier");
    // The body has the supplier's details but neither its name, nor a second number/date header.
    expect(screen.getAllByText(/SOCIETA' ALPHA SRL/)).toHaveLength(1);
    expect(screen.queryByText(/^Dated /)).toBeNull();
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
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Edit",
      "Mark as paid",
    ]);
    expect(mocks.apiFile).not.toHaveBeenCalled();
  });
});

describe("received list filters and recap", () => {
  const thisYear = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric" }).format(
      new Date(),
    ),
  );
  const parsed = (id: string, over: Partial<ReceivedInvoiceRecord>) =>
    record({
      id,
      parseStatus: "parsed",
      supplierName: "Alpha Srl",
      supplierVat: "IT01234567890",
      number: id,
      documentType: "TD01",
      issueDate: `${thisYear}-03-10`,
      totalCents: 10000,
      source: "import",
      original: null,
      ...over,
    });
  const serve = (received: ReceivedInvoiceRecord[]) =>
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/api/received") return { received };
      throw new Error(`unexpected ${path}`);
    });
  const list = [
    parsed("a1", { totalCents: 12200 }),
    parsed("a2", { issueDate: `${thisYear - 1}-11-02`, totalCents: 5000, paymentFlag: "paid" }),
    parsed("b1", {
      supplierName: "Beta GmbH",
      supplierVat: null,
      totalCents: 800,
      currency: "CHF",
    }),
  ];
  const recap = () =>
    screen.getByRole("region", { name: "Summary of the listed received invoices" });

  it("lists every year by default with the recap of all of them, one amount per currency", async () => {
    serve(list);
    await renderAt("/received");
    await screen.findByText(/Alpha Srl · No\. a1/);
    expect(screen.getByText(/No\. a2/)).toBeTruthy();
    expect(within(recap()).getByText("3")).toBeTruthy();
    expect(within(recap()).getAllByText(/172[.,]00/).length).toBeGreaterThan(0);
    expect(within(recap()).getAllByText(/CHF/).length).toBeGreaterThan(0);
  });

  it("filters by year and by sender through the URL, and clears the filters", async () => {
    serve(list);
    const router = await renderAt("/received");
    await screen.findByText(/Alpha Srl · No\. a1/);
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: String(thisYear) } });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ year: String(thisYear) }),
    );
    expect(screen.queryByText(/No\. a2/)).toBeNull();
    expect(within(recap()).getByText("2")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Sender"), { target: { value: "beta gmbh" } });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ supplier: "beta gmbh" }),
    );
    expect(screen.queryByText(/Alpha Srl · No\./)).toBeNull();
    expect(screen.getByText(/Beta GmbH · No\. b1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it("says when nothing matches the filters", async () => {
    serve(list);
    await renderAt("/received?year=2001");
    expect(await screen.findByText("No received invoices match these filters.")).toBeTruthy();
  });
});
