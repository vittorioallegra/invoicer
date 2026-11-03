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

const stored = {
  name: "Studio Example",
  vatNumber: "12345678903",
  taxCode: null,
  address: "Via Roma 1",
  postalCode: "00100",
  city: "Roma",
  province: "RM",
  country: "IT",
  email: "info@studio.it",
  phone: "+39061234567",
  regimeFiscale: "RF01",
};

function serve(profile: unknown) {
  mocks.api.mockImplementation(async (path: string) => {
    if (path === "/api/profile") return { profile };
    return {};
  });
}

async function renderPage() {
  const i18n = await createI18n("en");
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/settings/company"] }));
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

describe("Company page contacts", () => {
  it("shows the stored email and phone and saves the edited ones", async () => {
    serve(stored);
    await renderPage();
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    const phone = screen.getByLabelText("Phone") as HTMLInputElement;
    expect([email.value, phone.value]).toEqual(["info@studio.it", "+39061234567"]);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(phone, { target: { value: "+39 06 7654321" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/profile",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const call = mocks.api.mock.calls.find(
      ([path, init]) => path === "/api/profile" && init?.method,
    );
    expect(JSON.parse(call?.[1].body)).toMatchObject({
      email: "info@studio.it",
      phone: "+39 06 7654321",
    });
  });

  it("leaves them empty for a profile saved before, and flags an invalid value", async () => {
    serve({ ...stored, email: null, phone: null });
    await renderPage();
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    expect(email.value).toBe("");
    fireEvent.change(email, { target: { value: "nope" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(screen.getByText(/needs 5 to 12 digits/)).toBeTruthy();
    expect(mocks.api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
});
