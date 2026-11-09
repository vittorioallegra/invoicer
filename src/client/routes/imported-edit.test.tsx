import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClientRecord, EMPTY_CLIENT_DEFAULTS } from "../../shared/client";
import { ApiError } from "../../shared/errors";
import { EMPTY_INVOICE_DATA, type InvoiceRecord } from "../../shared/invoice";
import type { ReceivedInvoiceRecord } from "../../shared/received";
import { createI18n } from "../i18n";
import { createAppRouter } from "../router";

const mocks = vi.hoisted(() => ({ api: vi.fn(), apiFile: vi.fn(), downloadUrl: vi.fn() }));

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
vi.mock("../lib/invoice-download", () => ({
  downloadUrl: mocks.downloadUrl,
  downloadBytes: vi.fn(),
}));

const xml = readFileSync(
  resolve(process.cwd(), "src/shared/fatturapa/fixtures/IT01234567890_FPR01.xml"),
  "utf8",
);

const beta: ClientRecord = {
  id: "c1",
  type: "it_company",
  name: "Beta Srl",
  vatNumber: "12345678903",
  taxCode: null,
  foreignTaxId: null,
  countryCode: "IT",
  address: "Via Roma 1",
  postalCode: "00100",
  city: "Roma",
  province: "RM",
  recipientCode: "0000000",
  pec: null,
  email: null,
  pdfLanguage: "it",
  currency: "EUR",
  defaults: EMPTY_CLIENT_DEFAULTS,
};
const gamma: ClientRecord = { ...beta, id: "c2", name: "Gamma Srl" };

const imported = (over: Partial<InvoiceRecord> = {}): InvoiceRecord => ({
  id: "i1",
  source: "imported",
  documentType: "TD01",
  state: "delivered",
  paymentFlag: "paid",
  paidDate: "2014-12-18",
  clientId: "c1",
  clientName: "Beta Srl",
  hasOriginal: true,
  number: "123",
  requestedNumber: null,
  seriesId: "default",
  year: 2014,
  issueDate: "2014-12-18",
  invoiceDate: "2014-12-18",
  dueDate: null,
  currency: "EUR",
  totalCents: 610,
  linkedInvoiceId: null,
  linked: null,
  reissuesInvoiceId: null,
  lines: [],
  data: EMPTY_INVOICE_DATA,
  editorForm: null,
  numberReserved: false,
  releasable: false,
  rejection: null,
  reissuedById: null,
  ...over,
});

let invoice = imported();

function serve(onPut?: (body: Record<string, unknown>) => unknown) {
  mocks.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/api/clients") return { clients: [beta, gamma] };
    if (path === "/api/profile") return { profile: { country: "IT", vatNumber: "01234567890" } };
    if (path === "/api/tax") return { tax: { regimeFiscale: "RF01", cassa: null, ritenuta: null } };
    if (path === "/api/payment-methods") return { paymentMethods: [] };
    if (path === "/api/numbering-series") {
      return {
        series: [
          { id: "default", name: "Main", prefix: null, suffix: null, isDefault: true },
          { id: "ch", name: "CH", prefix: null, suffix: "/CH", isDefault: false },
        ],
      };
    }
    if (path === "/api/onboarding") {
      return { checklist: [], complete: true, send: { ready: true, reasons: [] }, pecTest: null };
    }
    if (path === "/api/invoices/i1" && init?.method === "PUT") {
      const result = onPut?.(JSON.parse(init.body ?? "{}"));
      if (result instanceof Error) throw result;
      return { invoice };
    }
    if (path === "/api/invoices/i1") return { invoice };
    throw new Error(`unexpected ${path}`);
  });
  mocks.apiFile.mockResolvedValue({
    bytes: new TextEncoder().encode(xml),
    fileName: "IT01234567890_00001.xml",
  });
}

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
  mocks.downloadUrl.mockReset();
  invoice = imported();
});
afterEach(cleanup);

const openActions = async () =>
  fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
const menu = () => screen.getAllByRole("menuitem").map((item) => item.textContent);
const putBody = () => {
  const call = mocks.api.mock.calls.find(
    ([path, init]) => path === "/api/invoices/i1" && init?.method === "PUT",
  );
  return call ? JSON.parse(call[1].body) : null;
};
const noSendActions = () => {
  for (const name of ["Finalize", "Delete", "Send", "Fix and resend"]) {
    expect(screen.queryByRole("button", { name: new RegExp(`^${name}`) })).toBeNull();
  }
};

describe("imported invoice, never edited", () => {
  it("offers Edit, the payment and the original in the menu, and nothing to send", async () => {
    serve();
    await renderAt("/invoices/i1");
    expect(await screen.findByText("Customer")).toBeTruthy();
    expect(screen.getByText("Imported")).toBeTruthy();
    noSendActions();
    await openActions();
    expect(menu()).toEqual(["Edit", "Undo payment", "Download original"]);
  });

  it("opens the editor on the lines of the XML, with the invoice's own client, number and date, and no way to send", async () => {
    serve();
    await renderAt("/invoices/i1");
    await screen.findByText("Customer");
    await openActions();
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Edit" }).getAttribute("aria-disabled")).not.toBe(
        "true",
      ),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));

    const description = await screen.findByDisplayValue("DESCRIZIONE DELLA FORNITURA");
    expect(description).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Client" }) as HTMLSelectElement).value).toBe(
      "c1",
    );
    expect((screen.getByLabelText("Number") as HTMLInputElement).value).toBe("123");
    expect(screen.getByText(/were read from the original file/)).toBeTruthy();
    expect(screen.getByText(/recalculated from the lines/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    noSendActions();
    expect(screen.queryByText(/Reserved/i)).toBeNull();

    // Save needs a change; change the client and a price, then save.
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Client" }), { target: { value: "c2" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "2,00" } });
    invoice = imported({
      clientId: "c2",
      clientName: "Gamma Srl",
      totalCents: 1220,
      lines: [
        {
          description: "DESCRIZIONE DELLA FORNITURA",
          note: "",
          quantityMilli: 5000,
          unit: null,
          unitPriceCents: 200,
          vatRateBp: 2200,
          natura: null,
        },
      ],
      editorForm: { lines: [] } as unknown as InvoiceRecord["editorForm"],
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody()).not.toBeNull());
    const body = putBody();
    expect(body).toMatchObject({
      clientId: "c2",
      number: "123",
      invoiceDate: "2014-12-18",
      requestedNumber: null,
      documentType: "TD01",
    });
    expect(body.lines[0]).toMatchObject({ unitPriceCents: 200, quantityMilli: 5000 });
    expect(body.editorForm.lines[0].price).toBe("2,00");
    // Back on the standard view of the edited invoice.
    expect(await screen.findByText("Saved.")).toBeTruthy();
    await openActions();
    expect(menu()).toEqual(["Edit", "Undo payment", "Download original"]);
  });

  it("goes back to the file view on Cancel", async () => {
    serve();
    await renderAt("/invoices/i1");
    await screen.findByText("Customer");
    await openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    await screen.findByDisplayValue("DESCRIZIONE DELLA FORNITURA");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Customer")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("seeds an import without an original file with one line holding the stored total", async () => {
    invoice = imported({ hasOriginal: false, totalCents: 61000 });
    serve();
    await renderAt("/invoices/i1");
    await screen.findByText(/only its number, date, customer and total were imported/);
    await openActions();
    expect(menu()).toEqual(["Edit", "Undo payment"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(((await screen.findByLabelText("Unit price")) as HTMLInputElement).value).toBe("610,00");
    expect(screen.getByText(/The invoice has no original file: one line/)).toBeTruthy();
    expect(mocks.apiFile).not.toHaveBeenCalled();
  });

  it("starts from an empty line and says so when the original cannot be read", async () => {
    serve();
    mocks.apiFile.mockRejectedValue(new Error("boom"));
    await renderAt("/invoices/i1");
    await screen.findByText(/could not be read as an invoice/);
    await openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(((await screen.findByLabelText("Unit price")) as HTMLInputElement).value).toBe("0,00");
    expect(screen.getByText(/could not be read, so the lines start empty/)).toBeTruthy();
  });
});

describe("imported invoice, edited", () => {
  const edited = () =>
    imported({
      lines: [
        {
          description: "Edited line",
          note: "",
          quantityMilli: 1000,
          unit: null,
          unitPriceCents: 500,
          vatRateBp: 2200,
          natura: null,
        },
      ],
      totalCents: 610,
    });

  it("opens the standard view, without reading the file, with Edit, the payment and the original", async () => {
    invoice = edited();
    serve();
    await renderAt("/invoices/i1");
    expect(await screen.findByDisplayValue("Edited line")).toBeTruthy();
    expect(screen.getByText("Imported")).toBeTruthy();
    expect(mocks.apiFile).not.toHaveBeenCalled();
    noSendActions();
    await openActions();
    expect(menu()).toEqual(["Edit", "Undo payment", "Download original"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Download original" }));
    expect(mocks.downloadUrl).toHaveBeenCalledWith("/api/invoices/i1/original");
  });

  it("edits a number that is not prefix + digits + suffix as free text and shows a taken number clearly", async () => {
    invoice = { ...edited(), number: "X-12/A" };
    serve(
      () =>
        new ApiError({
          type: "x",
          title: "Invoice number not available",
          status: 409,
          code: "number_unavailable",
          anchor: "number_unavailable",
        }),
    );
    await renderAt("/invoices/i1");
    await screen.findByDisplayValue("Edited line");
    await openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const number = screen.getByLabelText("Number") as HTMLInputElement;
    expect(number.disabled).toBe(false);
    fireEvent.change(number, { target: { value: "2014/A" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody()?.number).toBe("2014/A"));
    expect(await screen.findAllByText(/already used by another invoice/)).not.toHaveLength(0);
  });
  it("edits a number of a series as a plain number, printed with the series prefix and suffix", async () => {
    // A Swiss invoice: series CH (suffix /CH), printed 1/CH. The field holds just the 1.
    invoice = { ...edited(), number: "1/CH", seriesId: "ch", year: 2025, issueDate: "2025-02-28" };
    serve(() => undefined);
    await renderAt("/invoices/i1");
    await screen.findByDisplayValue("Edited line");
    await openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const number = screen.getByLabelText("Number") as HTMLInputElement;
    expect(number.value).toBe("1");
    expect((screen.getByLabelText("Series") as HTMLSelectElement).value).toBe("ch");
    expect(screen.getByText("Printed as 1/CH")).toBeTruthy();

    // Typing never changes the series, and letters are ignored.
    fireEvent.change(number, { target: { value: "12x" } });
    expect(number.value).toBe("12");
    expect((screen.getByLabelText("Series") as HTMLSelectElement).value).toBe("ch");
    expect(screen.getByText("Printed as 12/CH")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody()?.number).toBe("12/CH"));
    expect(putBody()?.seriesId).toBe("ch");
  });

  it("keeps the number when another series is picked and prints it with that series", async () => {
    invoice = { ...edited(), number: "1/CH", seriesId: "ch", year: 2025, issueDate: "2025-02-28" };
    serve(() => undefined);
    await renderAt("/invoices/i1");
    await screen.findByDisplayValue("Edited line");
    await openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Series"), { target: { value: "default" } });
    expect((screen.getByLabelText("Number") as HTMLInputElement).value).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody()?.number).toBe("1"));
    expect(putBody()?.seriesId).toBe("default");
  });
});

describe("received invoice edit sheet", () => {
  const received: ReceivedInvoiceRecord = {
    id: "r1",
    parseStatus: "parsed",
    supplierName: "ALPHA SRL",
    supplierVat: "IT01234567890",
    number: "55",
    issueDate: "2026-10-05",
    documentType: "TD01",
    currency: "EUR",
    totalCents: 12200,
    paymentFlag: "unpaid",
    paidDate: null,
    source: "import",
    receivedAt: 1,
    original: null,
  };

  it("sends the corrected summary and refuses a duplicate with a clear message", async () => {
    let answer: unknown = { received: { ...received, number: "56" } };
    mocks.api.mockImplementation(
      async (path: string, init?: { method?: string; body?: string }) => {
        if (path === "/api/received/r1" && init?.method === "PUT") {
          if (answer instanceof Error) throw answer;
          return answer;
        }
        if (path === "/api/received/r1") return { received };
        throw new Error(`unexpected ${path}`);
      },
    );
    await renderAt("/received/r1");
    await openActions();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Number"), { target: { value: "56" } });
    fireEvent.change(screen.getByLabelText("Total"), { target: { value: "99,50" } });

    answer = new ApiError({
      type: "x",
      title: "Conflict",
      status: 409,
      code: "conflict",
      anchor: "conflict",
      detail: "duplicate",
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/same supplier, number and date/)).toBeTruthy();

    answer = { received: { ...received, number: "56", totalCents: 9950 } };
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
    const calls = mocks.api.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(JSON.parse(calls.at(-1)?.[1].body)).toEqual({
      supplierName: "ALPHA SRL",
      supplierVat: "IT01234567890",
      number: "56",
      issueDate: "2026-10-05",
      documentType: "TD01",
      currency: "EUR",
      totalCents: 9950,
    });
  });

  it("does not send an invalid form", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/api/received/r1") return { received };
      throw new Error(`unexpected ${path}`);
    });
    await renderAt("/received/r1");
    await openActions();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Supplier"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
    expect(mocks.api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
});
