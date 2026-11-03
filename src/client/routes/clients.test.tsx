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

  it("adapts the form to the client type", async () => {
    mocks.api.mockResolvedValue({ clients: [] });
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    expect(await screen.findByLabelText("Codice destinatario")).toBeTruthy();
    expect(screen.getByLabelText("Province")).toBeTruthy();

    type("Client type", "eu_company");
    expect(screen.queryByLabelText("Codice destinatario")).toBeNull();
    expect(screen.queryByLabelText("Province")).toBeNull();
    expect(screen.getByLabelText("VAT / tax ID")).toBeTruthy();
    expect(screen.getByText(/XXXXXXX is used for foreign clients/)).toBeTruthy();
  });

  it("marks type rule errors without calling the server, then saves a valid client", async () => {
    mocks.api.mockResolvedValue({ clients: [] });
    await renderClients();
    fireEvent.click(await screen.findByRole("button", { name: "Add client" }));
    type("Name or company name", "Acme S.r.l.");
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
