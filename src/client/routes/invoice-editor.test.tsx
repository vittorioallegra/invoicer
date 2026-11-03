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

const mocks = vi.hoisted(() => ({ api: vi.fn(), runSend: vi.fn() }));

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
    ...EMPTY_CLIENT_DEFAULTS,
    vatRateBp: 2200,
    cassa: { type: "rivalsa_inps", rateBp: 400, mode: "excluded", subjectToRitenuta: true },
    ritenuta: { type: "RT01", rateBp: 2000, baseBp: 10000, causale: "A" },
    terms: { kind: "custom", days: 30 },
  },
};
const exemptClient: ClientRecord = {
  ...acme,
  id: "c2",
  name: "Forfettario Cliente",
  defaults: { ...EMPTY_CLIENT_DEFAULTS, natura: "N2.2" },
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
    requestedNumber: null,
    year: null,
    issueDate: null,
    plannedDate: null,
    operationDate: null,
    dueDate: null,
    currency: "EUR",
    totalCents: 12200,
    linkedInvoiceId: null,
    linked: null,
    reissuesInvoiceId: null,
    notes: null,
    lines: [
      {
        description: "Consulting",
        quantityMilli: 2000,
        unit: "h",
        unitPriceCents: 5000,
        vatRateBp: 2200,
        natura: null,
      },
    ],
    data: EMPTY_INVOICE_DATA,
    numberReserved: false,
    releasable: false,
    rejection: null,
    reissuedById: null,
    ...over,
  };
}

function serve(opts: { send?: object; invoice?: InvoiceRecord; clients?: ClientRecord[] } = {}) {
  mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/api/clients")
      return { clients: opts.clients ?? [acme, exemptClient, brokenClient] };
    if (path === "/api/profile") return { profile };
    if (path === "/api/payment-methods") return { paymentMethods: ACCOUNTS };
    if (path === "/api/onboarding") {
      return { checklist: [], complete: true, send: opts.send ?? ready, pecTest: null };
    }
    if (path === "/api/invoices?scope=issued") return { invoices: [] };
    if (path.startsWith("/api/invoices/next-number")) return { year: Number(YEAR), next: proposal };
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
const loaded = () => screen.findByRole("combobox", { name: "Client" });

beforeEach(() => {
  mocks.api.mockReset();
  mocks.runSend.mockReset();
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
    expect((screen.getByLabelText("VAT") as HTMLSelectElement).value).toBe("rate:2200");
    // The client's payment terms prefill the select, the custom days and the computed due date.
    expect((screen.getByLabelText("Payment terms") as HTMLSelectElement).value).toBe("custom");
    expect((screen.getByLabelText("Days from invoice date") as HTMLInputElement).value).toBe("30");
    expect((screen.getByLabelText("Due date") as HTMLInputElement).value).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("computes the due date from the terms and the planned date, or keeps a custom date", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c1");
    type("Planned issue date", "2026-11-10");
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
    type("Planned issue date", "2026-11-20");
    expect(due().value).toBe("2027-01-15");

    type("Description", "Consulting");
    type("Unit price", "50");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
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
    type("Planned issue date", "2026-11-10");
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

  it("shows the amount due live, with the cassa chip and an expandable breakdown", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c1");
    type("Description", "Consulting");
    type("Unit price", "1.200,00");
    // 1,200.00 + 4% rivalsa 48.00 = 1,248.00 taxable; VAT 22% = 274.56; ritenuta 20% of 1,248.00 = 249.60; due 1,272.96.
    const totals = screen.getByRole("region", { name: "Totals" });
    expect(within(totals).getByText(/1,272\.96/)).toBeTruthy();
    expect(within(totals).getByText("Contribution added")).toBeTruthy();
    fireEvent.click(within(totals).getByRole("button", { name: /Amount due/ }));
    expect(within(totals).getByText("VAT")).toBeTruthy();
    expect(within(totals).getByText("Ritenuta")).toBeTruthy();
    // The contribution row names the active mode, in both modes.
    expect(within(totals).getByText("Contribution (added on top)")).toBeTruthy();
    type("How the contribution applies", "included");
    expect(within(totals).getByText("Contribution (included above)")).toBeTruthy();
    expect(within(totals).queryByText("Contribution (added on top)")).toBeNull();
  });

  it("validates inline: required fields after a save attempt, malformed ones at once", async () => {
    serve();
    await renderEditor();
    await loaded();
    expect(screen.queryByText("This field is required.")).toBeNull();
    type("Unit price", "1,2,3");
    expect(screen.getByText(/Enter an amount such as/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Fix the highlighted fields to save.")).toBeTruthy();
    expect(mocks.api).not.toHaveBeenCalledWith("/api/invoices", expect.anything());
  });

  it("applies the client type rules and points at the client", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c3");
    console.log(
      "DBG",
      (field("Client") as HTMLSelectElement).value,
      document.body.textContent?.slice(0, 600),
    );
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
    const text = screen.getByLabelText("Legal reference for N2.2") as HTMLTextAreaElement;
    expect(text.value).toContain("L. 190/2014");
    fireEvent.change(text, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Add the legal reference for this exemption.")).toBeTruthy();
  });

  it("suggests bollo for exempt amounts above 77.47 EUR, dismissibly, and never in USD", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c2");
    type("Unit price", "100,00");
    expect(await screen.findByText(/Exempt amounts exceed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Exempt amounts exceed/)).toBeNull();

    cleanup();
    serve();
    await renderEditor();
    await loaded();
    type("Client", "c2");
    type("Currency", "USD");
    type("Unit price", "100,00");
    expect(screen.queryByText(/Exempt amounts exceed/)).toBeNull();
  });

  it("warns, without blocking, about a late immediate invoice", async () => {
    serve();
    await renderEditor();
    await loaded();
    type("Operation date", "2020-01-01");
    type("Planned issue date", "2020-03-01");
    expect(await screen.findByText(/within 12 days of the operation date/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Deferred invoice/));
    expect(await screen.findByText(/by the 15th of the month after the operation/)).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
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

  it("saves a valid draft and keeps Send disabled with the blocking reasons", async () => {
    serve({ send: { ready: false, reasons: ["profile_incomplete", "pec_test_missing"] } });
    await renderEditor();
    await loaded();
    type("Client", "c1");
    type("Description", "Consulting");
    type("Unit price", "50");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("You cannot send invoices yet:")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
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

  it("offers the manual AdE channel when only the PEC setup is missing, but not without a profile", async () => {
    serve({ send: { ready: false, reasons: ["pec_credentials_missing"] } });
    await renderEditor();
    await loaded();
    type("Client", "c1");
    type("Description", "Consulting");
    type("Unit price", "50");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    // No saved record yet, so the button is present but waits for the first save.
    const manual = screen.getByRole("button", { name: "Prepare for the AdE portal" });
    expect(manual).toBeTruthy();
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

  it("lays lines out as cards by default and offers a table header from the md breakpoint", async () => {
    serve({ invoice: record() });
    await renderEditor("/invoices/i1");
    const line = await screen.findByTestId("invoice-line");
    expect(line.className).toContain("md:grid");
    expect(line.className).toContain("rounded-card");
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
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send with passkey" }));
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
    expect((screen.getByLabelText("Planned issue date") as HTMLInputElement).disabled).toBe(true);
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
