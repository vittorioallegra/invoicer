import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CLIENT_DEFAULTS } from "../../shared/client";
import { createI18n } from "../i18n";
import { createAppRouter } from "../router";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));

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

const saved = {
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
  defaults: EMPTY_CLIENT_DEFAULTS,
};

async function renderClients() {
  const i18n = await createI18n("en");
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/clients"] }));
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

const pickKind = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => mocks.api.mockReset());
afterEach(cleanup);

describe("Clients screen", () => {
  it("shows the empty state with a call to action", async () => {
    mocks.api.mockResolvedValue({ clients: [] });
    await renderClients();
    expect(await screen.findByText("No clients yet")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add client" })).toHaveLength(1);
  });

  it("shows only the fields the client type needs", async () => {
    mocks.api.mockResolvedValue({ clients: [] });
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    expect(await screen.findByLabelText("Codice destinatario")).toBeTruthy();
    expect(screen.getByLabelText("Company name")).toBeTruthy();
    expect(screen.getByLabelText("Province")).toBeTruthy();
    expect(screen.getByLabelText("Partita IVA")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect((screen.getByLabelText("Country") as HTMLSelectElement).value).toBe("IT");

    pickKind("Private person");
    expect(screen.getByLabelText("Full name")).toBeTruthy();
    expect(screen.getByLabelText("Codice fiscale")).toBeTruthy();
    expect(screen.queryByLabelText("Partita IVA")).toBeNull();
    expect(screen.queryByLabelText("Codice destinatario")).toBeNull();
    expect(screen.getByText(/0000000 is set automatically/)).toBeTruthy();

    // Foreign private person: name, address and an optional tax ID, no Italian fields.
    type("Country", "FR");
    expect(screen.getByLabelText("Full name")).toBeTruthy();
    expect(screen.queryByLabelText("Codice fiscale")).toBeNull();
    expect(screen.queryByLabelText("Province")).toBeNull();
    expect(screen.getByLabelText("VAT / tax ID")).toBeTruthy();
    expect(screen.getByText(/XXXXXXX is set automatically/)).toBeTruthy();

    pickKind("Company");
    expect(screen.getByLabelText("Company name")).toBeTruthy();
    expect(screen.queryByLabelText("Province")).toBeNull();
    expect(screen.queryByLabelText("Codice fiscale")).toBeNull();
    expect(screen.getByLabelText("VAT / tax ID")).toBeTruthy();
    expect(screen.getByText(/XXXXXXX is set automatically/)).toBeTruthy();

    type("Country", "IT");
    expect(screen.getByLabelText("Partita IVA")).toBeTruthy();
    expect(screen.getByLabelText("Province")).toBeTruthy();
  });

  it("lists Italy first in the country select", async () => {
    mocks.api.mockResolvedValue({ clients: [] });
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    const select = (await screen.findByLabelText("Country")) as HTMLSelectElement;
    expect(select.options[0]?.value).toBe("IT");
    expect(select.options.length).toBeGreaterThan(60);
  });

  it("shows the invoice defaults and blocks a save with an invalid currency", async () => {
    mocks.api.mockResolvedValue({ clients: [] });
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    expect(await screen.findByLabelText("Payment terms")).toBeTruthy();
    type("Currency", "EURO");
    type("Company name", "Acme S.r.l.");
    type("Partita IVA", "12345678903");
    type("Street and number", "Via Roma 1");
    type("Postal code", "00100");
    type("City", "Roma");
    type("Province", "RM");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a 3-letter currency code.")).toBeTruthy();
    expect(mocks.api).not.toHaveBeenCalledWith(
      "/api/clients",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("offers the cassa and ritenuta flags once the owner has set them up, with the new-client defaults", async () => {
    const tax = {
      regimeFiscale: "RF01",
      cassa: { type: "TC04", rateBp: 400, mode: "excluded", subjectToRitenuta: false },
      ritenuta: { type: "RT01", rateBp: 2000, baseBp: 10000, causale: "A" },
    };
    mocks.api.mockImplementation(async (path: string) =>
      path === "/api/tax" ? { tax } : { clients: [] },
    );
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    const cassa = (await screen.findByLabelText(
      "Apply the pension fund contribution",
    )) as HTMLInputElement;
    const ritenuta = screen.getByLabelText(
      "Apply the withholding tax (ritenuta)",
    ) as HTMLInputElement;
    // Italian company: both on. Other client types: cassa on, ritenuta off.
    expect([cassa.checked, ritenuta.checked]).toEqual([true, true]);
    pickKind("Private person");
    expect([cassa.checked, ritenuta.checked]).toEqual([true, false]);
    pickKind("Company");
    expect([cassa.checked, ritenuta.checked]).toEqual([true, true]);
    type("Country", "DE");
    expect([cassa.checked, ritenuta.checked]).toEqual([true, false]);
    pickKind("Private person");
    expect([cassa.checked, ritenuta.checked]).toEqual([true, false]);
    // The old per-client fields are gone.
    expect(screen.queryByLabelText("VAT or exemption")).toBeNull();
    expect(screen.queryByLabelText("Cassa / rivalsa")).toBeNull();
    expect(screen.queryByLabelText(/bollo/i)).toBeNull();
  });

  it("points to Tax details while the cassa and ritenuta are not set up", async () => {
    mocks.api.mockImplementation(async (path: string) =>
      path === "/api/tax"
        ? { tax: { regimeFiscale: "RF01", cassa: null, ritenuta: null } }
        : { clients: [] },
    );
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    expect(await screen.findAllByRole("link", { name: "Set it up in Tax details" })).toHaveLength(
      2,
    );
    expect(screen.queryByLabelText(/Apply the/)).toBeNull();
  });

  it("saves the payment terms choice, with days only for a custom one", async () => {
    mocks.api.mockResolvedValue({ clients: [] });
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    const kind = screen.getByLabelText("Payment terms") as HTMLSelectElement;
    expect(kind.value).toBe("");
    expect([...kind.options].map((o) => o.value)).toEqual([
      "",
      "invoice_date",
      "eom_15",
      "eom_30",
      "eom_60",
      "custom",
    ]);
    expect(screen.queryByLabelText("Days from invoice date")).toBeNull();
    type("Payment terms", "custom");
    const days = screen.getByLabelText("Days from invoice date") as HTMLInputElement;
    expect(days.type).toBe("number");
    type("Days from invoice date", "60");
    type("Company name", "Acme S.r.l.");
    type("Partita IVA", "12345678903");
    type("Street and number", "Via Roma 1");
    type("Postal code", "00100");
    type("City", "Roma");
    type("Province", "RM");
    mocks.api.mockResolvedValue({ client: saved, clients: [saved] });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/clients",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mocks.api.mock.calls.find(
      ([path, init]) => path === "/api/clients" && init?.method === "POST",
    );
    const body = JSON.parse(((call?.[1] ?? {}) as { body?: string }).body ?? "{}");
    expect(body.defaults).toEqual({
      applyCassa: true,
      applyRitenuta: true,
      terms: { kind: "custom", days: 60 },
      seriesId: null,
    });
    expect(body.defaults).not.toHaveProperty("paymentTermsDays");
  });

  it("offers the numbering series only when there are several, and saves the choice", async () => {
    const series = [
      { id: "default", name: "Italia", prefix: null, suffix: null, isDefault: true },
      { id: "ch", name: "Svizzera", prefix: "CH-", suffix: null, isDefault: false },
    ];
    mocks.api.mockImplementation(async (path: string) =>
      path === "/api/numbering-series" ? { series } : { clients: [] },
    );
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    const select = (await screen.findByLabelText("Numbering series")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "default", "ch"]);
    type("Numbering series", "ch");
    type("Company name", "Acme S.r.l.");
    type("Partita IVA", "12345678903");
    type("Street and number", "Via Roma 1");
    type("Postal code", "00100");
    type("City", "Roma");
    type("Province", "RM");
    mocks.api.mockImplementation(async (path: string) =>
      path === "/api/numbering-series" ? { series } : { client: saved, clients: [saved] },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/clients",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mocks.api.mock.calls.find(
      ([path, init]) => path === "/api/clients" && init?.method === "POST",
    );
    const body = JSON.parse(((call?.[1] ?? {}) as { body?: string }).body ?? "{}");
    expect(body.defaults.seriesId).toBe("ch");
  });

  it("sends the fixed delivery code and country for each client type", async () => {
    mocks.api.mockResolvedValue({ clients: [] });
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    type("Country", "DE");
    type("Company name", "Beta GmbH");
    type("VAT / tax ID", "DE123456789");
    type("Street and number", "Hauptstrasse 1");
    type("Postal code", "10115");
    type("City", "Berlin");
    mocks.api.mockResolvedValue({ client: saved, clients: [saved] });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/clients",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mocks.api.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse(call?.[1].body as string);
    expect(body).toMatchObject({
      type: "eu_company",
      countryCode: "DE",
      foreignTaxId: "DE123456789",
      pdfLanguage: "en",
      currency: "EUR",
      recipientCode: "",
      province: "",
    });
  });

  it("saves a foreign private person with the derived type and no tax ID", async () => {
    mocks.api.mockResolvedValue({ clients: [] });
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    pickKind("Private person");
    type("Country", "US");
    type("Full name", "Jane Roe");
    type("Street and number", "5 Main St");
    type("Postal code", "10001");
    type("City", "New York");
    mocks.api.mockResolvedValue({ client: saved, clients: [saved] });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/clients",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mocks.api.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse(call?.[1].body as string);
    expect(body).toMatchObject({
      type: "foreign_private",
      countryCode: "US",
      foreignTaxId: "",
      pdfLanguage: "en",
      recipientCode: "",
      province: "",
      defaults: { applyRitenuta: false },
    });
  });

  it("shows kind and country in the list subtitle", async () => {
    const foreign = {
      ...saved,
      id: "c2",
      type: "foreign_private",
      name: "Jane Roe",
      vatNumber: null,
      foreignTaxId: null,
      countryCode: "US",
    };
    mocks.api.mockResolvedValue({ clients: [saved, foreign] });
    await renderClients();
    expect(await screen.findByText("Italian company · 12345678903")).toBeTruthy();
    expect(screen.getByText("Private person · United States")).toBeTruthy();
  });

  it("marks type rule errors without calling the server, then saves a valid client", async () => {
    mocks.api.mockResolvedValue({ clients: [] });
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    type("Company name", "Acme S.r.l.");
    type("Partita IVA", "12345678904");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/check digit does not match/)).toBeTruthy();
    expect(mocks.api).not.toHaveBeenCalledWith(
      "/api/clients",
      expect.objectContaining({ method: "POST" }),
    );

    type("Partita IVA", "12345678903");
    type("Street and number", "Via Roma 1");
    type("Postal code", "00100");
    type("City", "Roma");
    type("Province", "rm");
    mocks.api.mockResolvedValue({ client: saved, clients: [saved] });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/clients",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});
