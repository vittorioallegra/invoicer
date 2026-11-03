import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function serve(tax: unknown) {
  mocks.api.mockImplementation(async (path: string) => {
    if (path === "/api/tax") return { tax };
    return {};
  });
}

async function renderPage() {
  const i18n = await createI18n("en");
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/settings/tax"] }));
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

beforeEach(() => mocks.api.mockReset());
afterEach(cleanup);

describe("Tax details page", () => {
  it("shows the stored values and saves the edited ones", async () => {
    serve({
      regimeFiscale: "RF19",
      cassa: { type: "TC04", rateBp: 400, mode: "excluded", subjectToRitenuta: false },
      ritenuta: { type: "RT01", rateBp: 2000, baseBp: 10000, causale: "A" },
    });
    await renderPage();
    const regime = (await screen.findByLabelText(
      "Tax regime (regime fiscale)",
    )) as HTMLSelectElement;
    expect(regime.value).toBe("RF19");
    const rates = screen.getAllByLabelText("Rate") as HTMLInputElement[];
    expect(rates.map((input) => input.value)).toEqual(["4", "20"]);

    fireEvent.change(rates[0] as HTMLInputElement, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/tax",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const call = mocks.api.mock.calls.find(([path, init]) => path === "/api/tax" && init?.method);
    expect(JSON.parse(call?.[1].body)).toMatchObject({
      regimeFiscale: "RF19",
      cassa: { type: "TC04", rateBp: 500, mode: "excluded" },
      ritenuta: { type: "RT01", rateBp: 2000, baseBp: 10000, causale: "A" },
    });
  });

  it("hides the details of a cassa and a ritenuta that are not set", async () => {
    serve({ regimeFiscale: "RF01", cassa: null, ritenuta: null });
    await renderPage();
    await screen.findByLabelText("Cassa / rivalsa");
    expect(screen.queryByLabelText("Rate")).toBeNull();
    expect(screen.queryByLabelText("Payment reason")).toBeNull();
  });

  it("asks for the Company page first when there is no regime stored yet", async () => {
    serve({ regimeFiscale: null, cassa: null, ritenuta: null });
    await renderPage();
    const regime = (await screen.findByLabelText(
      "Tax regime (regime fiscale)",
    )) as HTMLSelectElement;
    expect(regime.disabled).toBe(true);
    expect(screen.getByRole("link", { name: "Open Company" })).toBeTruthy();
  });
});
