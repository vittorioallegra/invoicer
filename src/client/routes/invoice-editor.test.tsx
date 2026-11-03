import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClientRecord, EMPTY_CLIENT_DEFAULTS } from "../../shared/client";
import { ApiError } from "../../shared/errors";
import { EMPTY_INVOICE_DATA, type InvoiceRecord } from "../../shared/invoice";
import { createI18n } from "../i18n";
import { createAppRouter } from "../router";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  runSend: vi.fn(),
  downloadUrl: vi.fn(),
}));

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
vi.mock("../lib/api", () => ({ api: mocks.api }));
vi.mock("../lib/invoice-download", () => ({ downloadUrl: mocks.downloadUrl }));
vi.mock("../lib/send-flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/send-flow")>()),
  runSendFlow: mocks.runSend,
}));

/** What GET /api/invoices/next-number answers; tests change it to simulate another device. */
let proposal = 8;
const YEAR = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric" }).format(
  new Date(),
);

const acme: ClientRecord = {
  id: "c1",
  type: "it_company",
  name: "Acme S.r.l.",
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
  defaults: {
    applyCassa: true,
    applyRitenuta: true,
    terms: { kind: "custom", days: 30 },
    seriesId: null,
  },
};
/** The owner's Tax details: what a client's cassa and ritenuta flags copy onto a new invoice. */
const TAX = {
  regimeFiscale: "RF01",
  cassa: { type: "rivalsa_inps", rateBp: 400, mode: "excluded", subjectToRitenuta: true },
  ritenuta: { type: "RT01", rateBp: 2000, baseBp: 10000, causale: "A" },
};
const exemptClient: ClientRecord = {
  ...acme,
  id: "c2",
  name: "Forfettario Cliente",
  defaults: EMPTY_CLIENT_DEFAULTS,
};
const brokenClient: ClientRecord = { ...acme, id: "c3", name: "Broken", vatNumber: "12345678900" };

const profile = {
  name: "Mario Rossi",
  vatNumber: "12345678903",
  taxCode: null,
  address: "Via Milano 2",
  postalCode: "20100",
  city: "Milano",
  province: "MI",
  country: "IT",
  regimeFiscale: "RF01",
};

const DEFAULT_SERIES = {
  id: "default",
  name: "Italia",
  prefix: null,
  suffix: null,
  isDefault: true,
};
const CH_SERIES = { id: "ch", name: "Svizzera", prefix: "CH-", suffix: null, isDefault: false };

const ACCOUNTS = [
  {
    id: "pm1",
    label: "Fineco",
    iban: "IT60X0542811101000000123456",
    bic: null,
    accountHolder: "Mario Rossi",
    isDefault: true,
  },
  {
    id: "pm2",
    label: "Revolut",
    iban: "DE89370400440532013000",
    bic: "REVODEB2",
    accountHolder: "Mario Rossi",
    isDefault: false,
  },
];

const ready = { ready: true, reasons: [] };

function record(over: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: "i1",
    documentType: "TD01",
    state: "draft",
    paymentFlag: "unpaid",
    paidDate: null,
    clientId: "c1",
    clientName: "Acme S.r.l.",
    number: null,
    seriesId: "default",
    requestedNumber: null,
    year: null,
    issueDate: null,
    invoiceDate: null,
    dueDate: null,
    currency: "EUR",
    totalCents: 12200,
    linkedInvoiceId: null,
    linked: null,
    reissuesInvoiceId: null,
    lines: [
      {
        description: "Consulting",
        note: "",
        quantityMilli: 2000,
        unit: "h",
        unitPriceCents: 5000,
        vatRateBp: 2200,
        natura: null,
      },
    ],
    data: EMPTY_INVOICE_DATA,
    editorForm: null,
    numberReserved: false,
    releasable: false,
    rejection: null,
    reissuedById: null,
    ...over,
  };
}

function serve(
  opts: {
    send?: object;
    invoice?: InvoiceRecord;
    clients?: ClientRecord[];
    tax?: object;
    series?: object[];
  } = {},
) {
  mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/api/clients")
      return { clients: opts.clients ?? [acme, exemptClient, brokenClient] };
    if (path === "/api/profile") return { profile };
    if (path === "/api/tax") return { tax: opts.tax ?? TAX };
    if (path === "/api/payment-methods") return { paymentMethods: ACCOUNTS };
    if (path === "/api/numbering-series") return { series: opts.series ?? [DEFAULT_SERIES] };
    if (path === "/api/onboarding") {
      return { checklist: [], complete: true, send: opts.send ?? ready, pecTest: null };
    }
    if (path === "/api/invoices?scope=issued") return { invoices: [] };
    if (path.startsWith("/api/invoices/next-number")) {
      const series = new URLSearchParams(path.split("?")[1]).get("series");
      return {
        year: Number(YEAR),
        series: series ?? "default",
        next: series === "ch" ? 3 : proposal,
      };
    }
    if (path === "/api/invoices" && init?.method === "POST")
      return { invoice: record({ id: "new1" }) };
    if (path.startsWith("/api/invoices/") && opts.invoice) return { invoice: opts.invoice };
    throw new Error(`unexpected ${path}`);
  });
}

async function renderEditor(path = "/invoices/new") {
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

const field = (label: string | RegExp) =>
  label === "Client"
    ? screen.getByRole("combobox", { name: "Client" })
    : screen.getByLabelText(label);
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(field(label), { target: { value } });
/** The link above the title (the app navigation has links of the same name). */
const backLink = (name: string) => {
  const link = screen.getAllByRole("link", { name }).find((l) => !l.closest("nav"));
  if (!link) throw new Error(`no back link ${name}`);
  return link;
};
const loaded = () => screen.findByRole("combobox", { name: "Client" });

beforeEach(() => {
  mocks.api.mockReset();
  mocks.runSend.mockReset();
  mocks.downloadUrl.mockReset();
  proposal = 8;
});
afterEach(cleanup);

describe("Invoice editor", () => {
  it("prefills a new invoice from the client defaults and the default bank account", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c1");
    expect((screen.getByLabelText("Cassa / rivalsa") as HTMLSelectElement).value).toBe(
      "rivalsa_inps",
    );
    expect((screen.getByLabelText("Ritenuta") as HTMLSelectElement).value).toBe("RT01");
    expect((screen.getByLabelText("Bank account") as HTMLSelectElement).value).toBe("pm1");
    expect((screen.getByLabelText("Payment method") as HTMLSelectElement).value).toBe("MP05");
    // VAT is never prefilled, not even from the client: the owner chooses it per line.
    expect((screen.getByLabelText("VAT") as HTMLSelectElement).value).toBe("");
    // The client's payment terms prefill the select, the custom days and the computed due date.
    expect((screen.getByLabelText("Payment terms") as HTMLSelectElement).value).toBe("custom");
    expect((screen.getByLabelText("Days from invoice date") as HTMLInputElement).value).toBe("30");
    expect((screen.getByLabelText("Due date") as HTMLInputElement).value).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("copies the Tax details onto the invoice only for the flags the client has on", async () => {
    serve({ clients: [{ ...acme, defaults: { ...acme.defaults, applyRitenuta: false } }] });
    await renderEditor();
    await loaded();
    type("Client", "c1");
    expect((screen.getByLabelText("Cassa / rivalsa") as HTMLSelectElement).value).toBe(
      "rivalsa_inps",
    );
    expect((screen.getByLabelText("Ritenuta") as HTMLSelectElement).value).toBe("");

    cleanup();
    serve({ tax: { regimeFiscale: "RF01", cassa: null, ritenuta: null } });
    await renderEditor();
    await loaded();
    type("Client", "c1");
    // Nothing applies: the section stays closed until it is opened.
    const toggle = screen.getByRole("button", { name: /Contribution, withholding and stamp duty/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Cassa / rivalsa")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect((screen.getByLabelText("Cassa / rivalsa") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Ritenuta") as HTMLSelectElement).value).toBe("");
  });

  it("computes the due date from the terms and the planned date, or keeps a custom date", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c1");
    type("Invoice date", "2026-11-10");
    const due = () => screen.getByLabelText("Due date") as HTMLInputElement;
    expect(due().value).toBe("2026-12-10");
    expect(due().readOnly).toBe(true);
    type("Payment terms", "eom_30");
    expect(due().value).toBe("2026-12-31");
    type("Payment terms", "custom");
    type("Days from invoice date", "90");
    expect(due().value).toBe("2027-02-08");

    // A custom date starts from the computed one and is then kept as typed.
    type("Due date from", "custom");
    expect(due().readOnly).toBe(false);
    expect(due().value).toBe("2027-02-08");
    type("Due date", "2027-01-15");
    type("Invoice date", "2026-11-20");
    expect(due().value).toBe("2027-01-15");

    type("Description", "Consulting");
    type("Unit price", "50");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/invoices",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mocks.api.mock.calls.find(([path]) => path === "/api/invoices");
    const body = JSON.parse(((call?.[1] ?? {}) as { body?: string }).body ?? "{}");
    expect(body.dueDate).toBe("2027-01-15");
    expect(body.data.payment).toMatchObject({
      terms: { kind: "custom", days: 90 },
      dueDateCustom: true,
    });
  });

  it("computes the due date for each terms choice and shows the days only for custom", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c1");
    type("Invoice date", "2026-11-10");
    const due = () => screen.getByLabelText("Due date") as HTMLInputElement;
    type("Payment terms", "eom_15");
    expect(screen.queryByLabelText("Days from invoice date")).toBeNull();
    expect(due().value).toBe("2026-12-15");
    type("Payment terms", "eom_60");
    expect(due().value).toBe("2027-01-31");
    type("Payment terms", "custom");
    type("Days from invoice date", "5");
    expect(due().value).toBe("2026-11-15");
    type("Payment terms", "invoice_date");
    expect(screen.queryByLabelText("Days from invoice date")).toBeNull();
    expect(due().value).toBe("2026-11-10");
  });

  it("has no terms and no due date when the client has no default terms", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c1");
    type("Payment terms", "");
    expect(screen.queryByLabelText("Due date from")).toBeNull();
    expect((screen.getByLabelText("Due date") as HTMLInputElement).readOnly).toBe(false);
  });

  it("shows the amount due live, with no contribution chip and an expandable breakdown", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c1");
    type("Description", "Consulting");
    type("Unit price", "1.200,00");
    type("VAT", "rate:2200");
    // 1,200.00 + 4% rivalsa 48.00 = 1,248.00 taxable; VAT 22% = 274.56; ritenuta 20% of 1,248.00 = 249.60; due 1,272.96.
    const totals = screen.getByRole("region", { name: "Totals" });
    expect(within(totals).getByText(/1,272\.96/)).toBeTruthy();
    expect(within(totals).queryByText(/Contribution (added|included)/)).toBeNull();
    fireEvent.click(within(totals).getByRole("button", { name: /Amount due/ }));
    expect(within(totals).getByText("VAT")).toBeTruthy();
    // The ritenuta row shows how it was computed: rate and the amount it applies to.
    expect(within(totals).getByText("Withholding tax 20% on €1,248.00")).toBeTruthy();
    // The contribution row names its percentage and the active mode, in both modes.
    expect(within(totals).getByText("Contribution INPS rivalsa 4% (added on top)")).toBeTruthy();
    expect(within(totals).queryByText("Taxable without contribution")).toBeNull();
    type("Applies", "included");
    // Typed 1,200.00 with the contribution inside: base 1,153.85 + 46.15 = 1,200.00.
    expect(within(totals).getByText("Taxable without contribution")).toBeTruthy();
    expect(within(totals).getByText("€1,153.85")).toBeTruthy();
    expect(within(totals).getByText("Contribution INPS rivalsa 4%")).toBeTruthy();
    expect(within(totals).getByText("€46.15")).toBeTruthy();
    expect(within(totals).getByText("Taxable total")).toBeTruthy();
    expect(within(totals).queryByText(/added on top/)).toBeNull();
  });

  it("starts every line without VAT and flags it once the line has content", async () => {
    serve();
    await renderEditor();
    await loaded();
    expect(screen.queryByText("Choose a VAT rate or an exemption for this line.")).toBeNull();
    type("Description", "Consulting");
    type("Unit price", "50");
    expect(screen.getByText("Choose a VAT rate or an exemption for this line.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    expect((screen.getAllByLabelText("VAT") as HTMLSelectElement[]).map((s) => s.value)).toEqual([
      "",
      "",
    ]);
  });

  it("keeps the amounts of the filled lines when a line without VAT is added", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Description", "Consulting");
    type("Unit price", "50");
    type("Quantity", "2");
    expect(screen.getByText("€100.00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    expect(screen.getAllByTestId("invoice-line")).toHaveLength(2);
    expect(screen.getByText("€100.00")).toBeTruthy();
  });

  it("shows problems as hints but saves whatever was typed, keeping the raw text", async () => {
    serve();
    await renderEditor();
    await loaded();
    expect(screen.queryByText("This field is required.")).toBeNull();
    type("Unit price", "1,2,3");
    expect(screen.getByText(/Enter an amount such as/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/invoices",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mocks.api.mock.calls.find(
      ([path, init]) => path === "/api/invoices" && init?.method,
    );
    expect(JSON.parse(call?.[1].body).editorForm.lines[0].price).toBe("1,2,3");
  });

  it("applies the client type rules and points at the client", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c3");
    expect(
      await screen.findByText("This client's data is not complete enough for an e-invoice:"),
    ).toBeTruthy();
    expect(screen.getByText(/check digit does not match/)).toBeTruthy();
  });

  it("requires and prefills the legal text of a natura line", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c2");
    type("VAT", "natura:N2.2");
    const text = screen.getByLabelText("Legal reference for N2.2") as HTMLTextAreaElement;
    expect(text.value).toContain("L. 190/2014");
    fireEvent.change(text, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Add the legal reference for this exemption.")).toBeTruthy();
  });

  it("suggests bollo for exempt amounts above 77.47 EUR, dismissibly, and never in USD", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c2");
    type("VAT", "natura:N2.2");
    type("Unit price", "100,00");
    expect(await screen.findByText(/Exempt amounts exceed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Exempt amounts exceed/)).toBeNull();

    cleanup();
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c2");
    type("VAT", "natura:N2.2");
    type("Currency", "USD");
    type("Unit price", "100,00");
    expect(screen.queryByText(/Exempt amounts exceed/)).toBeNull();
  });

  it("warns, without blocking, about an invoice dated more than 12 days back", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Invoice date", "2020-03-01");
    expect(await screen.findByText(/within 12 days of its date/)).toBeTruthy();
    expect(screen.queryByLabelText(/Deferred invoice/)).toBeNull();
    type("Invoice date", "");
    expect(screen.queryByText(/within 12 days of its date/)).toBeNull();
  });

  it("opens the contribution section when one applies and summarises it when closed", async () => {
    serve({
      clients: [{ ...acme, defaults: { ...acme.defaults, applyRitenuta: true, applyCassa: true } }],
      tax: {
        regimeFiscale: "RF01",
        cassa: { type: "TC04", rateBp: 400, mode: "excluded", subjectToRitenuta: false },
        ritenuta: { type: "RT06", rateBp: 2000, baseBp: 1000, causale: "A" },
      },
    });
    await renderEditor();
    await loaded();
    const toggle = () =>
      screen.getByRole("button", { name: /Contribution, withholding and stamp duty/ });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toContain("None applied");
    type("Client", "c1");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByLabelText("Apply bollo (virtual stamp)"));
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toContain("TC04 4% · RT06 20% of 10% · stamp duty");
    // Open: one border around the box, the panel set apart from the header by a separator.
    fireEvent.click(toggle());
    const panel = document.getElementById("inv-extras-panel") as HTMLElement;
    expect(panel.className).toContain("border-t");
    expect(panel.className).toContain("p-4");
    expect(panel.parentElement?.className).toContain("border");
  });

  it("shows an always-visible optional note on each line and saves it", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c1");
    type("Description", "Consulting");
    type("Note (optional)", "Phase 1");
    type("Unit price", "50");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/invoices",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mocks.api.mock.calls.find(([path]) => path === "/api/invoices");
    const body = JSON.parse(((call?.[1] ?? {}) as { body?: string }).body ?? "{}");
    expect(body.lines[0]).toMatchObject({ description: "Consulting", note: "Phase 1" });
  });

  it("reorders lines with the move buttons and saves them in that order", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c1");
    type("Description", "First");
    type("Unit price", "10");
    type("VAT", "rate:2200");
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    const descriptions = () =>
      (screen.getAllByLabelText("Description") as HTMLInputElement[]).map((i) => i.value);
    fireEvent.change(screen.getAllByLabelText("Description")[1] as HTMLElement, {
      target: { value: "Second" },
    });
    fireEvent.change(screen.getAllByLabelText("Unit price")[1] as HTMLElement, {
      target: { value: "20" },
    });
    fireEvent.change(screen.getAllByLabelText("VAT")[1] as HTMLElement, {
      target: { value: "rate:2200" },
    });
    // Disabled at the ends.
    expect(screen.getByRole("button", { name: "Move up line 1" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Move down line 2" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Move up line 2" }));
    expect(descriptions()).toEqual(["Second", "First"]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/invoices",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mocks.api.mock.calls.find(([path]) => path === "/api/invoices");
    const body = JSON.parse(((call?.[1] ?? {}) as { body?: string }).body ?? "{}");
    expect(body.lines.map((line: { description: string }) => line.description)).toEqual([
      "Second",
      "First",
    ]);
  });

  it("saves the invoice note", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c1");
    type("Description", "Consulting");
    type("Unit price", "50");
    type("VAT", "rate:2200");
    type("Note", "Printed on the invoice");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/invoices",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mocks.api.mock.calls.find(([path]) => path === "/api/invoices");
    const body = JSON.parse(((call?.[1] ?? {}) as { body?: string }).body ?? "{}");
    expect(body.data.note).toBe("Printed on the invoice");
    expect(body.notes).toBeUndefined();
  });

  it("flags a description and note that do not fit Descrizione together", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Description", "D".repeat(600));
    type("Note (optional)", "N".repeat(500));
    type("Unit price", "50");
    type("VAT", "rate:2200");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/must fit 1000 characters together/)).toBeTruthy();
  });

  it("offers the accounts and saves the chosen one as a copy on the invoice", async () => {
    serve();
    await renderEditor();
    await loaded();
    const select = screen.getByLabelText("Bank account") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "None",
      "Fineco · IT60 •••• 3456",
      "Revolut · DE89 •••• 3000",
    ]);
    type("Bank account", "pm2");
    type("Client", "c1");
    // Choosing a client does not override the chosen account.
    expect(select.value).toBe("pm2");
    type("Description", "Consulting");
    type("Unit price", "50");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/invoices",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mocks.api.mock.calls.find(([path]) => path === "/api/invoices");
    const body = JSON.parse(((call?.[1] ?? {}) as { body?: string }).body ?? "{}");
    expect(body.data.payment).toEqual({
      method: "MP05",
      iban: "DE89370400440532013000",
      bic: "REVODEB2",
      bankName: "",
      accountHolder: "Mario Rossi",
      terms: { kind: "custom", days: 30 },
      dueDateCustom: false,
    });
  });

  it("keeps the details of a deleted account on an existing invoice", async () => {
    const invoice = record({
      data: {
        ...EMPTY_INVOICE_DATA,
        payment: {
          method: "MP05",
          iban: "FR1420041010050500013M02606",
          bic: null,
          accountHolder: null,
          bankName: "Old Bank",
          terms: null,
          dueDateCustom: false,
        },
      },
    });
    serve({ invoice });
    await renderEditor("/invoices/i1");
    await loaded();
    const select = screen.getByLabelText("Bank account") as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe("Saved on this invoice · FR14 •••• 2606");
    // Deleting later from Settings never reaches this copy; clearing it is explicit.
    type("Bank account", "");
    expect(select.value).toBe("");
  });

  it("saves a draft whatever the send readiness, and lists the blocking reasons", async () => {
    serve({ send: { ready: false, reasons: ["profile_incomplete", "pec_test_missing"] } });
    await renderEditor();
    await loaded();
    type("Client", "c1");
    type("Description", "Consulting");
    type("Unit price", "50");
    expect(screen.getByText("You cannot send invoices yet:")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/invoices",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mocks.api.mock.calls.find(([path]) => path === "/api/invoices");
    const body = JSON.parse(((call?.[1] ?? {}) as { body?: string }).body ?? "{}");
    expect(body).toMatchObject({
      documentType: "TD01",
      clientId: "c1",
      lines: [{ description: "Consulting", quantityMilli: 1000, unitPriceCents: 5000 }],
    });
  });

  it("finalises for the manual AdE channel when only the PEC setup is missing", async () => {
    serve({ invoice: record(), send: { ready: false, reasons: ["pec_credentials_missing"] } });
    mocks.runSend.mockResolvedValue({ messageId: null, fileName: "IT1_00001.xml" });
    await renderEditor("/invoices/i1");
    await loaded();
    expect(screen.getByText(/instead of sending it by PEC/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    expect((await screen.findByText(/nothing is sent by the app/)).textContent).toContain(
      "AdE portal",
    );
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    await waitFor(() => expect(mocks.runSend).toHaveBeenCalled());
    expect(mocks.runSend.mock.calls[0]?.[0]).toBe("i1");
    expect(mocks.runSend.mock.calls[0]?.[2]).toBe("manual");
  });

  it("does not finalise without the company details: it points to them", async () => {
    serve({
      invoice: record(),
      send: { ready: false, reasons: ["profile_incomplete", "pec_credentials_missing"] },
    });
    await renderEditor("/invoices/i1");
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finalize" }));
    const link = await screen.findByRole("link", { name: "The company details are not complete." });
    expect(link.getAttribute("href")).toBe("/settings/profile");
    expect(mocks.runSend).not.toHaveBeenCalled();
  });

  it("shows the client title once: as the select label, with no repeated heading", async () => {
    serve();
    await renderEditor();
    await loaded();
    expect(screen.getAllByText("Client")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Client" })).toBeNull();
    expect(screen.getByRole("region", { name: "Client" })).toBeTruthy();
  });

  it("puts Finalize on the title row and Delete, Duplicate and Save under the form", async () => {
    serve({ invoice: record() });
    await renderEditor("/invoices/i1");
    await loaded();
    expect(screen.queryByRole("toolbar")).toBeNull();
    const title = screen.getByRole("heading", { level: 1 });
    const finalize = screen.getByRole("button", { name: "Finalize" });
    expect(finalize.className).toContain("bg-primary");
    // Nothing to download before finalising.
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(title.compareDocumentPosition(finalize) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const remove = screen.getByRole("button", { name: "Delete" });
    const duplicate = screen.getByRole("button", { name: "Duplicate" });
    const save = screen.getByRole("button", { name: "Save" });
    expect(remove.className).toContain("mr-auto");
    expect(remove.className).toContain("text-danger");
    expect(
      remove.compareDocumentPosition(duplicate) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(duplicate.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      finalize.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The sticky bar shows totals only.
    const totals = screen.getByRole("region", { name: "Totals" });
    expect(within(totals).getAllByRole("button")).toHaveLength(1);
    // Deleting still asks for a confirmation first.
    fireEvent.click(remove);
    expect(screen.getByRole("button", { name: "Confirm delete" })).toBeTruthy();
  });

  it("starts with a back link to the list the invoice belongs to", async () => {
    serve({ invoice: record() });
    await renderEditor("/invoices/i1");
    await loaded();
    expect(backLink("Home").getAttribute("href")).toBe("/");
    cleanup();
    serve({ invoice: record({ state: "delivered", number: "7", year: 2026 }) });
    await renderEditor("/invoices/i1");
    await screen.findByText("Delivered");
    expect(backLink("Issued").getAttribute("href")).toBe("/issued");
  });

  it("offers the stored PDF and XML of a finalised invoice in the Download menu and nothing else", async () => {
    serve({
      invoice: record({ state: "delivered", number: "7", year: 2026, issueDate: "2026-03-01" }),
    });
    await renderEditor("/invoices/i1");
    await screen.findByText("No. 7/2026");
    expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Download" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["PDF", "XML"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "XML" }));
    expect(mocks.downloadUrl).toHaveBeenCalledWith("/api/invoices/i1/xml");
    // Only Duplicate (and the credit note) remain at the bottom: no Delete, no Save.
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Duplicate" })).toBeTruthy();
  });

  it("closes the Download menu with Escape", async () => {
    serve({
      invoice: record({ state: "sent", number: "7", year: 2026, issueDate: "2026-03-01" }),
    });
    await renderEditor("/invoices/i1");
    await screen.findByText("No. 7/2026");
    const trigger = screen.getByRole("button", { name: "Download" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("checks the invoice on Finalize, lists what fails with links to the fields and does nothing else", async () => {
    serve({ invoice: record({ clientId: null, clientName: null }) });
    await renderEditor("/invoices/i1");
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    // The dialog says what is checked and what happens next.
    expect(await screen.findByText(/numbered, finalised and sent to the SdI/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Finalize and send with passkey" }));
    const problem = await screen.findByRole("button", { name: "Client" });
    expect(screen.getByText(/cannot be finalised yet/)).toBeTruthy();
    expect(mocks.runSend).not.toHaveBeenCalled();
    expect(mocks.api).not.toHaveBeenCalledWith(
      "/api/invoices/i1",
      expect.objectContaining({ method: "PUT" }),
    );
    // Choosing the problem closes the dialog and moves the focus to the field.
    fireEvent.click(problem);
    await waitFor(() => expect(document.activeElement).toBe(field("Client")));
  });

  it("saves what is on screen and then runs the send flow when every check passes", async () => {
    serve({ invoice: record() });
    mocks.runSend.mockResolvedValue({ messageId: "m1", fileName: "IT1_00001.xml" });
    await renderEditor("/invoices/i1");
    await loaded();
    type("Description", "Consulting, edited");
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finalize and send with passkey" }));
    await waitFor(() => expect(mocks.runSend).toHaveBeenCalled());
    const put = mocks.api.mock.calls.find(
      ([path, init]) => path === "/api/invoices/i1" && init?.method === "PUT",
    );
    expect(JSON.parse(put?.[1].body).lines[0].description).toBe("Consulting, edited");
    expect(mocks.runSend.mock.calls[0]?.[0]).toBe("i1");
    expect(mocks.runSend.mock.calls[0]?.[2]).toBe("pec");
  });

  it("finalises a new invoice: it is created first and the flow runs on the new one", async () => {
    serve();
    mocks.runSend.mockResolvedValue({ messageId: "m1", fileName: "IT1_00001.xml" });
    await renderEditor();
    await loaded();
    type("Client", "c1");
    type("Description", "Consulting");
    type("Unit price", "50");
    type("VAT", "rate:2200");
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finalize and send with passkey" }));
    await waitFor(() => expect(mocks.runSend).toHaveBeenCalled());
    expect(mocks.api).toHaveBeenCalledWith(
      "/api/invoices",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.runSend.mock.calls[0]?.[0]).toBe("new1");
  });

  it("opens the inline client creation sheet", async () => {
    serve();
    await renderEditor();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "New client" }));
    expect(await screen.findByRole("heading", { name: "New client" })).toBeTruthy();
  });

  it("shows an issued invoice read-only, with payment status and no save", async () => {
    serve({
      invoice: record({ state: "delivered", number: "7", year: 2026, issueDate: "2026-03-01" }),
    });
    await renderEditor("/invoices/i1");
    expect(await screen.findByText("No. 7/2026")).toBeTruthy();
    expect(screen.getByText(/can no longer be edited/)).toBeTruthy();
    expect((screen.getByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create credit note" })).toBeTruthy();
    expect(screen.getByLabelText("Paid")).toBeTruthy();
  });

  it("lays each line out as a bordered card with the note and the read-only amount", async () => {
    serve({ invoice: record() });
    await renderEditor("/invoices/i1");
    const line = await screen.findByTestId("invoice-line");
    expect(line.className).toContain("rounded-card");
    expect(within(line).getByLabelText("Note (optional)")).toBeTruthy();
    expect(within(line).getByText("Amount")).toBeTruthy();
  });
});

describe("Invoice editor, number on the invoice", () => {
  const numberInput = () => screen.getByLabelText("Number") as HTMLInputElement;
  const postedBody = () => {
    const call = mocks.api.mock.calls.find(
      ([path, init]) =>
        path === "/api/invoices" && (init as { method?: string } | undefined)?.method === "POST",
    );
    return JSON.parse(((call?.[1] ?? {}) as { body?: string }).body ?? "{}");
  };
  const fillAndSave = async () => {
    type("Client", "c1");
    type("Description", "Consulting");
    type("Unit price", "50");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(postedBody().documentType).toBe("TD01"));
    return postedBody();
  };

  it("prefills the next free number of the year and leaves it automatic when untouched", async () => {
    serve();
    await renderEditor();
    await loaded();
    await waitFor(() => expect(numberInput().value).toBe("8"));
    expect(numberInput().disabled).toBe(false);
    expect(screen.queryByText(/leaves a gap/)).toBeNull();
    expect((await fillAndSave()).requestedNumber).toBeNull();
  });

  it("sends the edited number and warns, without blocking, when it leaves a gap", async () => {
    serve();
    await renderEditor();
    await loaded();
    await waitFor(() => expect(numberInput().value).toBe("8"));
    fireEvent.change(numberInput(), { target: { value: "12" } });
    expect(
      screen.getByText(new RegExp(`the numbers 8 to 11 of ${YEAR} will stay unused`)),
    ).toBeTruthy();
    fireEvent.change(numberInput(), { target: { value: "9" } });
    expect(screen.getByText(new RegExp(`the number 8 of ${YEAR} will stay unused`))).toBeTruthy();
    fireEvent.change(numberInput(), { target: { value: "120" } });
    expect((await fillAndSave()).requestedNumber).toBe(120);
  });

  it("treats a number equal to the proposal as automatic and rejects text", async () => {
    serve();
    await renderEditor();
    await loaded();
    await waitFor(() => expect(numberInput().value).toBe("8"));
    fireEvent.change(numberInput(), { target: { value: "ab" } });
    expect(screen.getByText("Enter a whole number, 1 or more.")).toBeTruthy();
    fireEvent.change(numberInput(), { target: { value: "8" } });
    expect(screen.queryByText("Enter a whole number, 1 or more.")).toBeNull();
    expect((await fillAndSave()).requestedNumber).toBeNull();
  });

  it("points out a number below the next free one", async () => {
    serve();
    await renderEditor();
    await loaded();
    await waitFor(() => expect(numberInput().value).toBe("8"));
    fireEvent.change(numberInput(), { target: { value: "3" } });
    expect(
      screen.getByText("The number must be 8 or higher: lower numbers are already issued."),
    ).toBeTruthy();
  });

  it("shows the series select even with a single series", async () => {
    serve();
    await renderEditor();
    await loaded();
    expect((field("Series") as HTMLSelectElement).options).toHaveLength(1);
  });

  it("lays the document fields out two per row: type and currency, series and number, date", async () => {
    serve();
    await renderEditor();
    await loaded();
    const grid = field("Document type").closest("div.grid") as HTMLElement;
    expect(grid.className).toContain("sm:grid-cols-2");
    expect(grid.className).not.toContain("grid-cols-3");
    const order = ["Document type", "Currency", "Series", "Number", "Invoice date"].map((label) =>
      Array.from(grid.querySelectorAll("label, select, input")).indexOf(field(label)),
    );
    expect(order.every((index, i) => index >= 0 && (i === 0 || index > (order[i - 1] ?? 0)))).toBe(
      true,
    );
  });

  it("starts in the client's series, proposes its number and sends the series", async () => {
    const swiss = { ...acme, defaults: { ...acme.defaults, seriesId: "ch" } };
    serve({ series: [DEFAULT_SERIES, CH_SERIES], clients: [swiss] });
    await renderEditor();
    await loaded();
    expect((screen.getByLabelText("Series") as HTMLSelectElement).value).toBe("default");
    type("Client", "c1");
    await waitFor(() =>
      expect((screen.getByLabelText("Series") as HTMLSelectElement).value).toBe("ch"),
    );
    await waitFor(() => expect(numberInput().value).toBe("3"));
    expect(screen.getByText("CH-3")).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining("series=ch"));
    const body = await fillAndSave();
    expect(body.seriesId).toBe("ch");
    expect(body.requestedNumber).toBeNull();
  });

  it("shows the number as it will be printed on the title row, and nothing while it is unknown", async () => {
    serve({ series: [DEFAULT_SERIES, CH_SERIES] });
    await renderEditor();
    await loaded();
    expect(await screen.findByText(`No. 8/${YEAR}`)).toBeTruthy();
    const heading = screen.getByRole("heading", { level: 1, name: "New invoice" });
    expect(heading.parentElement?.textContent).toContain(`No. 8/${YEAR}`);
    type("Series", "ch");
    expect(await screen.findByText(`No. CH-3/${YEAR}`)).toBeTruthy();
    fireEvent.change(numberInput(), { target: { value: "" } });
    fireEvent.change(numberInput(), { target: { value: "12" } });
    expect(screen.getByText(`No. CH-12/${YEAR}`)).toBeTruthy();
    // Text that is not a number cannot be printed.
    fireEvent.change(numberInput(), { target: { value: "x" } });
    expect(screen.queryByText(/^No\. /)).toBeNull();
  });

  it("shows the assigned number of a stored invoice on the title row", async () => {
    serve({
      series: [DEFAULT_SERIES, CH_SERIES],
      invoice: record({ state: "sending", number: "CH-7", seriesId: "ch", year: 2026 }),
    });
    await renderEditor("/invoices/i1");
    await loaded();
    expect(screen.getAllByText("No. CH-7/2026")).toHaveLength(1);
  });

  it("switching the series proposes that series' next number", async () => {
    serve({ series: [DEFAULT_SERIES, CH_SERIES] });
    await renderEditor();
    await loaded();
    await waitFor(() => expect(numberInput().value).toBe("8"));
    type("Series", "ch");
    await waitFor(() => expect(numberInput().value).toBe("3"));
  });

  it("shows the series of an issued invoice read-only", async () => {
    serve({
      series: [DEFAULT_SERIES, CH_SERIES],
      invoice: record({
        state: "sending",
        number: "CH-7",
        seriesId: "ch",
        year: 2026,
        issueDate: "2026-03-01",
      }),
    });
    await renderEditor("/invoices/i1");
    await loaded();
    expect((screen.getByLabelText("Series") as HTMLSelectElement).disabled).toBe(true);
    expect(numberInput().value).toBe("CH-7");
  });

  it("shows the number requested on a stored draft, editable", async () => {
    serve({ invoice: record({ requestedNumber: 120 }) });
    await renderEditor("/invoices/i1");
    await loaded();
    await waitFor(() => expect(numberInput().value).toBe("120"));
    expect(numberInput().disabled).toBe(false);
    expect(
      screen.getByText(new RegExp(`the numbers 8 to 119 of ${YEAR} will stay unused`)),
    ).toBeTruthy();
  });

  it("shows the assigned number read-only from reservation on", async () => {
    serve({
      invoice: record({ state: "sending", number: "7", year: 2026, issueDate: "2026-03-01" }),
    });
    await renderEditor("/invoices/i1");
    await loaded();
    expect(numberInput().value).toBe("7");
    expect(numberInput().disabled).toBe(true);
    expect(mocks.api).not.toHaveBeenCalledWith(expect.stringContaining("next-number"));
  });

  it("shows a number taken meanwhile next to the field with the new proposal", async () => {
    serve({ invoice: record({ requestedNumber: 9 }) });
    mocks.runSend.mockRejectedValue(
      new ApiError({
        type: "urn:invoicer:error:number_unavailable",
        title: "Invoice number not available",
        status: 409,
        code: "number_unavailable",
        anchor: "error-number-unavailable",
        detail: "requestedNumber: unavailable (the next free number is 10)",
      }),
    );
    await renderEditor("/invoices/i1");
    await loaded();
    await waitFor(() => expect(numberInput().value).toBe("9"));
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finalize and send with passkey" }));
    proposal = 10;
    expect(
      await screen.findByText("That number is no longer free. The next free number is 10."),
    ).toBeTruthy();
    expect(numberInput().value).toBe("9");
  });
});

describe("Invoice editor, rejected invoices", () => {
  const base = { number: "7", year: 2026, issueDate: "2026-03-01" };
  const errors = [
    { code: "00311", description: "CodiceDestinatario non valido" },
    { code: "00999", description: "Altro errore" },
  ];

  it("keeps a rejected invoice editable with the deadline and the SdI error next to the field", async () => {
    serve({
      invoice: record({
        ...base,
        state: "rejected",
        rejection: { at: 0, deadline: Date.now() + 86_400_000, errors },
      }),
    });
    await renderEditor("/invoices/i1");
    expect(await screen.findByText(/Fix and resend by/)).toBeTruthy();
    expect(screen.getByText(/number and issue date stay the same/)).toBeTruthy();
    expect((screen.getByLabelText("Description") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("Invoice date") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    // Listed in the banner and repeated next to the client field.
    expect(screen.getAllByText("SdI error 00311: CodiceDestinatario non valido")).toHaveLength(2);
    expect(screen.getAllByText("SdI error 00999: Altro errore")).toHaveLength(1);
  });

  it("offers only the reissue action once the window has closed", async () => {
    serve({ invoice: record({ ...base, state: "rejected_expired" }) });
    await renderEditor("/invoices/i1");
    expect(await screen.findByText("The resend window has closed.")).toBeTruthy();
    expect((screen.getByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reissue as new invoice" })).toBeTruthy();
  });

  it("links to the reissue draft when one already exists", async () => {
    serve({ invoice: record({ ...base, state: "rejected_expired", reissuedById: "n2" }) });
    await renderEditor("/invoices/i1");
    expect(await screen.findByText("Open the reissued invoice")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reissue as new invoice" })).toBeNull();
  });
});
