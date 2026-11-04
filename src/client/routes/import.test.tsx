import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceRecord } from "../../shared/invoice";
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

const fixtures = (name: string) => resolve(process.cwd(), "src/shared/fatturapa/fixtures", name);
const xml = readFileSync(fixtures("IT01234567890_FPR01.xml"), "utf8");

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

const profile = { profile: { country: "IT", vatNumber: "01234567890", name: "Me" } };

describe("import page", () => {
  it("imports issued invoice files and shows the result with a reason for each skipped file", async () => {
    mocks.api.mockImplementation(async (path: string, init?: { body?: Uint8Array }) => {
      if (path === "/api/profile") return profile;
      if (path === "/api/invoices/import") {
        const text = new TextDecoder().decode(init?.body);
        return text.includes("<Numero>2</Numero>")
          ? { outcome: "number_conflict", id: "taken", number: "2" }
          : { outcome: "imported", id: "n1", clientLinked: true };
      }
      throw new Error(`unexpected ${path}`);
    });
    await renderAt("/import?kind=issued");
    const input = (await screen.findByLabelText("Files")) as HTMLInputElement;
    const file = (name: string, text: string) => new File([text], name, { type: "text/xml" });
    fireEvent.change(input, {
      target: {
        files: [
          file("one.xml", xml.replace("<Numero>123</Numero>", "<Numero>1</Numero>")),
          file("two.xml", xml.replace("<Numero>123</Numero>", "<Numero>2</Numero>")),
          file("junk.xml", "not an invoice"),
        ],
      },
    });
    expect(screen.getByText("3 files selected")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Import" });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    expect(await screen.findByText("1 imported, 2 skipped")).toBeTruthy();
    expect(
      screen.getByText("Number 2 is already used by another invoice in the same series and year."),
    ).toBeTruthy();
    expect(screen.getByText("This is not a readable FatturaPA invoice.")).toBeTruthy();
    expect(screen.getByText("Imported")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import more files" }));
    expect(await screen.findByLabelText("Files")).toBeTruthy();
  });
});

describe("imported invoice", () => {
  const record = {
    id: "i1",
    source: "imported",
    documentType: "TD01",
    state: "delivered",
    paymentFlag: "paid",
    paidDate: "2014-12-18",
    clientId: null,
    clientName: "DITTA BETA",
    number: "123",
    year: 2014,
    issueDate: "2014-12-18",
    invoiceDate: "2014-12-18",
    dueDate: null,
    currency: "EUR",
    totalCents: 610,
    lines: [],
    data: {},
  } as unknown as InvoiceRecord;

  it("shows the file read-only with the Imported badge and no editing actions", async () => {
    mocks.apiFile.mockResolvedValue({
      bytes: new TextEncoder().encode(xml),
      fileName: "IT01234567890_00001.xml",
    });
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/api/invoices/i1") return { invoice: record };
      throw new Error(`unexpected ${path}`);
    });
    await renderAt("/invoices/i1");
    expect(await screen.findByText("Invoice 123")).toBeTruthy();
    expect(screen.getByText("Imported")).toBeTruthy();
    expect(await screen.findByText("Supplier")).toBeTruthy();
    expect(screen.getByText("Download original")).toBeTruthy();
    expect(screen.queryByText("Finalize")).toBeNull();
    expect(screen.queryByText("Edit")).toBeNull();
  });
});
