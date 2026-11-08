import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceRecord } from "../../shared/invoice";
import { createI18n } from "../i18n";
import { buildXls, type FixtureCell } from "../import/xls-fixture";
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
  const file = (name: string, text: string) => new File([text], name, { type: "text/xml" });
  const received = xml.replace(
    /<IdCodice>01234567890<\/IdCodice>/g,
    "<IdCodice>05555555555</IdCodice>",
  );

  it("imports issued and received files in one go and shows the result with a reason for each skipped file", async () => {
    mocks.api.mockImplementation(async (path: string, init?: { body?: Uint8Array }) => {
      if (path === "/api/profile") return profile;
      if (path === "/api/numbering-series") return { series: [] };
      if (path === "/api/received/import") return { outcome: "imported", id: "r1" };
      if (path === "/api/invoices/import") {
        const text = new TextDecoder().decode(init?.body);
        return text.includes("<Numero>2</Numero>")
          ? { outcome: "number_conflict", id: "taken", number: "2" }
          : { outcome: "imported", id: "n1", clientLinked: true };
      }
      throw new Error(`unexpected ${path}`);
    });
    await renderAt("/import");
    const input = (await screen.findByLabelText("Files")) as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          file("one.xml", xml.replace("<Numero>123</Numero>", "<Numero>1</Numero>")),
          file("two.xml", xml.replace("<Numero>123</Numero>", "<Numero>2</Numero>")),
          file("supplier.xml", received),
          file("junk.xml", "not an invoice"),
        ],
      },
    });
    expect(screen.getByText("4 files selected")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Import" });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    expect(await screen.findByText("2 imported, 2 skipped")).toBeTruthy();
    expect(screen.getByText("Issued 1, 2014-12-18, DITTA BETA")).toBeTruthy();
    expect(screen.getByText("Received 123, 2014-12-18, SOCIETA' ALPHA SRL")).toBeTruthy();
    expect(
      screen.getByText("Number 2 is already used by another invoice in the same series and year."),
    ).toBeTruthy();
    expect(screen.getByText("This is not a readable FatturaPA invoice.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import more files" }));
    expect(await screen.findByLabelText("Files")).toBeTruthy();
  });

  it.each(["/import?kind=issued", "/import?kind=received", "/import"])(
    "shows the combined import for %s",
    async (path) => {
      mocks.api.mockImplementation(async (url: string) =>
        url === "/api/profile" ? profile : { series: [] },
      );
      await renderAt(path);
      const kinds = await screen.findByRole("navigation", { name: "Import" });
      expect(
        within(kinds).getByRole("link", { name: "Invoices" }).getAttribute("aria-current"),
      ).toBe("page");
      expect(within(kinds).queryByRole("link", { name: "Issued invoices" })).toBeNull();
      expect(await screen.findByLabelText("Files")).toBeTruthy();
    },
  );

  it("asks for the VAT number in the company details instead of guessing", async () => {
    mocks.api.mockImplementation(async (url: string) =>
      url === "/api/profile"
        ? { profile: { country: "IT", vatNumber: "", name: "Me" } }
        : { series: [] },
    );
    await renderAt("/import");
    expect(await screen.findByText(/including the VAT number/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open the company details" });
    expect(link.getAttribute("href")).toBe("/settings/company");
    fireEvent.change(await screen.findByLabelText("Files"), {
      target: { files: [file("one.xml", xml)] },
    });
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("import page back link", () => {
  beforeEach(() => {
    mocks.api.mockResolvedValue(profile);
  });
  // The back link is the first link of the page (the sidebar also has these labels).
  const backLink = async () => {
    const heading = await screen.findByRole("heading", { level: 1, name: "Import" });
    return heading.parentElement?.parentElement?.parentElement?.querySelector("a") ?? null;
  };
  const backHref = async () => (await backLink())?.getAttribute("href");

  it.each([
    "/import?kind=issued",
    "/import?kind=received&from=received",
    "/import?kind=clients&from=clients",
    "/import",
  ])("always goes back to Settings (%s)", async (path) => {
    await renderAt(path);
    expect(await backHref()).toBe("/settings");
    expect((await backLink())?.textContent).toBe("Settings");
  });

  it("keeps the Settings back link when switching between the import kinds", async () => {
    await renderAt("/import?kind=issued");
    const kinds = await screen.findByRole("navigation", { name: "Import" });
    fireEvent.click(within(kinds).getByRole("link", { name: "Clients" }));
    await screen.findByRole("heading", { level: 1, name: "Import" });
    await waitFor(async () => expect(await backHref()).toBe("/settings"));
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
    hasOriginal: true,
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
    expect(await screen.findByText("Invoice 123/2014")).toBeTruthy();
    expect(screen.getByText("Imported")).toBeTruthy();
    expect(await screen.findByText("Supplier")).toBeTruthy();
    expect(screen.getByText("Download original")).toBeTruthy();
    expect(screen.queryByText("Finalize")).toBeNull();
    expect(screen.queryByText("Edit")).toBeNull();
  });

  it("explains that a summary import has no original and offers no download", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/api/invoices/i1") {
        return { invoice: { ...record, hasOriginal: false, clientName: "Name from the summary" } };
      }
      throw new Error(`unexpected ${path}`);
    });
    await renderAt("/invoices/i1");
    expect(
      await screen.findByText(/only its number, date, customer and total were imported/),
    ).toBeTruthy();
    expect(screen.getByText(/Name from the summary/)).toBeTruthy();
    expect(screen.queryByText("Download original")).toBeNull();
    expect(mocks.apiFile).not.toHaveBeenCalled();
  });
});

describe("clients CSV import (AC 17)", () => {
  it("previews the rows, imports the valid ones and lists the others with their reason", async () => {
    const csv = readFileSync(
      resolve(process.cwd(), "src/client/import/fixtures/fic-clients.csv"),
      "utf8",
    );
    const sent: unknown[][] = [];
    mocks.api.mockImplementation(async (path: string, init?: { body?: string }) => {
      if (path === "/api/clients/import") {
        const rows = (JSON.parse(init?.body ?? "{}") as { rows: unknown[] }).rows;
        sent.push(rows);
        return {
          results: rows.map((_, index) =>
            index === 1
              ? { status: "skipped", reason: "duplicate", id: "c9" }
              : { status: "imported", id: `c${index}` },
          ),
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    await renderAt("/import?kind=clients");
    const input = (await screen.findByLabelText("CSV file")) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([csv], "clienti.csv", { type: "text/csv" })] },
    });
    // The preview names the rows with problems before anything is sent.
    expect(
      await screen.findByText("4 rows ready to import, 2 with problems (skipped)."),
    ).toBeTruthy();
    expect(screen.getByText(/Row 5 · Delta S\.r\.l\./)).toBeTruthy();
    expect(screen.getByText(/VAT number: Enter the 11-digit partita IVA/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import 4 clients" }));
    expect(await screen.findByText("3 imported, 3 skipped")).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(4);
    expect(screen.getByText("Already imported.")).toBeTruthy();
    expect(screen.getAllByText(/Not imported\./)).toHaveLength(2);
  });
});

describe("summary import", () => {
  const sheet = (name: string, rows: FixtureCell[][]) => buildXls([{ name, rows }]);
  const header = ["# Fattura emessa", "Data", "Cliente", "P.IVA", "CF", "Imponibile", "IVA"];
  const receivedHeader = [
    "# Fattura ricevuta",
    "Data",
    "Fornitore",
    "P.IVA",
    "CF",
    "Imponibile",
    "IVA",
  ];
  const day = (iso: string) =>
    (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
  const xls = sheet("Summary", [
    ["Gennaio"],
    header,
    ["3/CH", day("2025-03-31"), "Acme Srl", " ", " ", 100, 22],
    [4, day("2024-05-02"), "Beta Ltd", " ", " ", 10, 0],
    [5, 0, "No date", " ", " ", 10, 0],
    ["Totale"],
    receivedHeader,
    [7, day("2024-01-05"), "Tool Shop", "98765432109 ", " ", 100, 22],
    ["Totale"],
  ]);
  const asFile = (bytes: Uint8Array) =>
    new File([bytes as BlobPart], "riepilogo.xls", { type: "application/vnd.ms-excel" });

  it("previews the file, then imports it and shows the result with the skipped rows", async () => {
    mocks.api.mockImplementation(async (path: string, init?: { body?: string }) => {
      if (path === "/api/numbering-series" && !init) return { series: [] };
      if (path === "/api/numbering-series") return { series: {} };
      const { rows } = JSON.parse(init?.body ?? "{}") as { rows: { number?: string }[] };
      if (path === "/api/invoices/import-summary") {
        return {
          results: rows.map((row) =>
            row.number === "4"
              ? { outcome: "duplicate", id: "old" }
              : { outcome: "imported", id: "n1" },
          ),
        };
      }
      return { results: rows.map(() => ({ outcome: "imported", id: "r1" })) };
    });
    await renderAt("/import?kind=summary");
    const input = (await screen.findByLabelText("Summary file (.xls)")) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [asFile(xls)] } });
    expect(await screen.findByText("2 issued invoices")).toBeTruthy();
    expect(screen.getByText("1 received invoice")).toBeTruthy();
    expect(screen.getByText("Years 2024 to 2025")).toBeTruthy();
    expect(screen.getByText("CH (numbers like 1/CH)")).toBeTruthy();
    expect(screen.getByText("1 row cannot be read and will be skipped:")).toBeTruthy();
    expect(screen.getByText(/Row 5 \(issued\)/)).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    const start = screen.getByRole("button", { name: "Import" });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    expect(await screen.findByText("2 imported, 2 skipped")).toBeTruthy();
    expect(screen.getByText("Issued 3/CH, 2025-03-31, Acme Srl")).toBeTruthy();
    expect(screen.getByText("Already imported.")).toBeTruthy();
    expect(screen.getByText("Received 7, 2024-01-05, Tool Shop")).toBeTruthy();
    const created = mocks.api.mock.calls.find(
      (call) => call[0] === "/api/numbering-series" && call[1]?.method === "POST",
    );
    expect(JSON.parse(created?.[1].body)).toEqual({ name: "CH", prefix: null, suffix: "/CH" });
  });

  it("says when the file is not an account summary", async () => {
    mocks.api.mockResolvedValue({ series: [] });
    await renderAt("/import?kind=summary");
    const input = (await screen.findByLabelText("Summary file (.xls)")) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["a,b"], "x.xls")] } });
    expect(
      await screen.findByText(/could not be read as a Fatture in Cloud account summary/),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  describe("review of the invoices", () => {
    const future = sheet("Summary", [
      ["Gennaio"],
      header,
      [3, day("2025-03-31"), "Acme Srl", " ", " ", 100, 22],
      [4, day("2026-10-30"), "Open Client", " ", " ", 10, 0],
      [5, day("2099-12-31"), "Later Client", " ", " ", 10, 0],
      ["Totale"],
      receivedHeader,
      [7, day("2099-12-30"), "Later Shop", " ", " ", 10, 0],
      ["Totale"],
    ]);
    const body = (path: string) => {
      const call = mocks.api.mock.calls.find((c) => c[0] === path);
      return call ? (JSON.parse(call[1].body) as { rows: Record<string, unknown>[] }).rows : [];
    };
    const sent = () => body("/api/invoices/import-summary").map((row) => [row.number, row.paid]);
    beforeEach(() => {
      mocks.api.mockImplementation(async (path: string, init?: { body?: string }) => {
        if (path === "/api/numbering-series") return { series: [] };
        const { rows } = JSON.parse(init?.body ?? "{}") as { rows: unknown[] };
        return { results: rows.map(() => ({ outcome: "imported", id: "n1" })) };
      });
    });
    const load = async () => {
      await renderAt("/import?kind=summary");
      const input = (await screen.findByLabelText("Summary file (.xls)")) as HTMLInputElement;
      fireEvent.change(input, { target: { files: [asFile(future)] } });
      await screen.findByText("2 issued invoices");
    };
    const start = async () => {
      const button = screen.getByRole("button", { name: "Import" });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(button);
      await screen.findByText(/imported/);
    };

    it("creates an issued invoice dated after today as an invoice to send, never paid", async () => {
      await load();
      expect(
        screen.getByText(
          "1 issued invoice dated after today will be created as an invoice to send (not sent, not paid)",
        ),
      ).toBeTruthy();
      expect(screen.getByText("0 received invoices")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Review the invoices/ }));
      expect(screen.getByText("Will be created as an invoice to send")).toBeTruthy();
      const later = screen.getByLabelText("Import Issued 5, 2099-12-31, Later Client");
      expect((later as HTMLInputElement).checked).toBe(true);
      // No Paid box is offered for it, the global box does not apply.
      expect(screen.queryByLabelText("Paid: Issued 5, 2099-12-31, Later Client")).toBeNull();
      await start();
      expect(sent()).toEqual([
        ["3", true],
        ["4", true],
      ]);
      const drafts = body("/api/invoices/import-summary-drafts");
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        number: "5",
        date: "2099-12-31",
        amounts: { taxableCents: 1000, taxCents: 0 },
      });
      expect(drafts[0]).not.toHaveProperty("paid");
      expect(
        screen.getByText(/Created as an invoice to send, check it before sending/),
      ).toBeTruthy();
    });

    it("leaves a received invoice dated after today out until it is ticked", async () => {
      await load();
      expect(screen.getByText("1 invoice is left out (see the review below).")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Review the invoices/ }));
      expect(screen.getByText("Not issued yet")).toBeTruthy();
      const later = screen.getByLabelText("Import Received 7, 2099-12-30, Later Shop");
      expect((later as HTMLInputElement).checked).toBe(false);
      fireEvent.click(later);
      expect(await screen.findByText("1 received invoice")).toBeTruthy();
      await start();
      expect(body("/api/received/import-summary")).toHaveLength(1);
    });

    it("stores an invoice as not paid when its Paid box is unticked", async () => {
      await load();
      fireEvent.click(screen.getByRole("button", { name: /Review the invoices/ }));
      fireEvent.click(screen.getByLabelText("Paid: Issued 4, 2026-10-30, Open Client"));
      await start();
      expect(sent()).toEqual([
        ["3", true],
        ["4", false],
      ]);
    });
  });
});
