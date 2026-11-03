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

const pickType = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
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
    expect(screen.getAllByRole("radio")).toHaveLength(4);

    pickType("Private person in Italy");
    expect(screen.getByLabelText("Full name")).toBeTruthy();
    expect(screen.getByLabelText("Codice fiscale")).toBeTruthy();
    expect(screen.queryByLabelText("Partita IVA")).toBeNull();
    expect(screen.queryByLabelText("Codice destinatario")).toBeNull();
    expect(screen.getByText(/0000000 is set automatically/)).toBeTruthy();

    pickType("Company in the EU");
    expect(screen.queryByLabelText("Province")).toBeNull();
    expect(screen.queryByLabelText("Codice fiscale")).toBeNull();
    expect(screen.getByLabelText("VAT / tax ID")).toBeTruthy();
    expect(screen.getByLabelText("Country")).toBeTruthy();
    expect(screen.getByText(/XXXXXXX is set automatically/)).toBeTruthy();
  });

  it("keeps the invoice defaults collapsed and opens them on a validation error", async () => {
    mocks.api.mockResolvedValue({ clients: [] });
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    const toggle = await screen.findByRole("button", { name: /Invoice defaults/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Payment due after (days)")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByLabelText("Rate (%)")).toBeNull();
    type("Pension fund contribution (cassa/rivalsa)", "rivalsa_inps");
    expect(screen.getByLabelText("Rate (%)")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // Fill a valid client except the cassa rate (hidden while collapsed).
    type("Company name", "Acme S.r.l.");
    type("Partita IVA", "12345678903");
    type("Street and number", "Via Roma 1");
    type("Postal code", "00100");
    type("City", "Roma");
    type("Province", "RM");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This value is not valid.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Invoice defaults/ }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it("sends the fixed delivery code and country for each client type", async () => {
    mocks.api.mockResolvedValue({ clients: [] });
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    pickType("Company in the EU");
    type("Company name", "Beta GmbH");
    type("Country", "DE");
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

  it("marks type rule errors without calling the server, then saves a valid client", async () => {
    mocks.api.mockResolvedValue({ clients: [] });
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    type("Company name", "Acme S.r.l.");
    type("Partita IVA", "12345678904");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/check digit does not match/)).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledTimes(1);

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
