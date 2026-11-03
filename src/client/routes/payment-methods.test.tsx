import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentMethodRecord } from "../../shared/payment-method";
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

const fineco: PaymentMethodRecord = {
  id: "pm1",
  label: "Fineco",
  iban: "IT60X0542811101000000123456",
  bic: null,
  bankName: "Fineco Bank",
  accountHolder: null,
  isDefault: true,
};
const revolut: PaymentMethodRecord = {
  id: "pm2",
  label: "Revolut",
  iban: "DE89370400440532013000",
  bic: null,
  bankName: null,
  accountHolder: null,
  isDefault: false,
};

function serve(list: PaymentMethodRecord[]) {
  mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/api/payment-methods" && !init?.method) return { paymentMethods: list };
    return { paymentMethod: list[0], paymentMethods: list };
  });
}

async function renderPage() {
  const i18n = await createI18n("en");
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: ["/settings/payment-methods"] }),
  );
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

describe("Payment methods page", () => {
  it("lists accounts with a masked IBAN and marks the default", async () => {
    serve([fineco, revolut]);
    await renderPage();
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("Fineco")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Default")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(/IT60 •••• 3456 · Fineco Bank/)).toBeTruthy();
    expect(screen.queryByText("IT60X0542811101000000123456")).toBeNull();
    expect(within(rows[1] as HTMLElement).queryByText("Default")).toBeNull();
  });

  it("sets another account as the default", async () => {
    serve([fineco, revolut]);
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set Revolut as default" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith("/api/payment-methods/pm2/default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
  });

  it("shows an empty state with a call to action that opens the form", async () => {
    serve([]);
    await renderPage();
    expect(await screen.findByText("No bank account yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add bank account" }));
    expect(await screen.findByRole("dialog", { name: "New bank account" })).toBeTruthy();
  });

  it("validates the IBAN before calling the server", async () => {
    serve([]);
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add bank account" }));
    fireEvent.change(await screen.findByLabelText("Short name"), { target: { value: "Fineco" } });
    fireEvent.change(screen.getByLabelText("IBAN"), { target: { value: "IT00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This IBAN is not valid.")).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it("creates an account with the typed details", async () => {
    serve([]);
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add bank account" }));
    fireEvent.change(await screen.findByLabelText("Short name"), { target: { value: "Fineco" } });
    fireEvent.change(screen.getByLabelText("IBAN"), {
      target: { value: "IT60 X054 2811 1010 0000 0123 456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/payment-methods",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("asks for confirmation before deleting", async () => {
    serve([fineco]);
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Fineco" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete account" }));
    expect(mocks.api).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith("/api/payment-methods/pm1", { method: "DELETE" }),
    );
  });
});
