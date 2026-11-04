import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../i18n";
import { RecurringSheet } from "./recurring-sheet";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api: mocks.api }));

async function show() {
  const i18n = await createI18n("en");
  const root = createRootRoute({
    component: () => <RecurringSheet invoiceId="inv-1" open onOpenChange={() => undefined} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/recurring", component: () => <p>Done</p> }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.api.mockReset();
});

describe("Repeat an invoice", () => {
  it("creates a template from the invoice with the typed schedule", async () => {
    mocks.api.mockResolvedValue({ id: "t1" });
    await show();
    const day = (await screen.findByLabelText(/Day of the month/)) as HTMLInputElement;
    fireEvent.change(day, { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    const [path, init] = mocks.api.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe("/api/recurring");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({
      invoiceId: "inv-1",
      intervalMonths: 1,
      dayOfMonth: 15,
      endDate: null,
      maxCount: null,
    });
  });

  it("blocks an invalid schedule", async () => {
    await show();
    const day = await screen.findByLabelText(/Day of the month/);
    fireEvent.change(day, { target: { value: "" } });
    expect(
      (screen.getByRole("button", { name: "Create schedule" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/Check the schedule/);
  });
});
