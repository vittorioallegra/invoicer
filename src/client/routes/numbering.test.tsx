import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../shared/errors";
import type { NumberingSeriesRecord } from "../../shared/numbering";
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

const italia: NumberingSeriesRecord = {
  id: "default",
  name: "Italia",
  prefix: null,
  suffix: null,
  isDefault: true,
};
const svizzera: NumberingSeriesRecord = {
  id: "ch",
  name: "Svizzera",
  prefix: "CH-",
  suffix: null,
  isDefault: false,
};

function serve(list: NumberingSeriesRecord[]) {
  mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/api/numbering-series" && !init?.method) return { series: list };
    const target = list.find((s) => path === `/api/numbering-series/${s.id}`) ?? list[0];
    return { series: target };
  });
}

async function renderPage() {
  const i18n = await createI18n("en");
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/settings/numbering"] }));
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

const conflict = (detail: string) =>
  new ApiError({
    type: "urn:invoicer:error:conflict",
    title: "Conflict",
    status: 409,
    code: "conflict",
    anchor: "error-conflict",
    detail,
  });

describe("Numbering series page", () => {
  it("lists the series with an example number and marks the default", async () => {
    serve([italia, svizzera]);
    await renderPage();
    expect(await screen.findByRole("button", { name: /Italia/ })).toBeTruthy();
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getByText("Example: CH-1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add series" })).toBeTruthy();
  });

  it("creates a series with a prefix and shows a live example", async () => {
    serve([italia]);
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add series" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Svizzera" } });
    fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "CH-" } });
    fireEvent.change(screen.getByLabelText("Suffix"), { target: { value: "/A" } });
    expect(screen.getAllByText("Example: CH-1/A").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/numbering-series",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mocks.api.mock.calls.find(([p, i]) => p === "/api/numbering-series" && i?.method);
    expect(JSON.parse(((call?.[1] ?? {}) as { body?: string }).body ?? "{}")).toEqual({
      name: "Svizzera",
      prefix: "CH-",
      suffix: "/A",
    });
  });

  it("refuses characters outside letters, digits and - / . before sending", async () => {
    serve([italia]);
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add series" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "CH_" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Use letters, digits, - / and . only.")).toBeTruthy();
    expect(mocks.api).not.toHaveBeenCalledWith(
      "/api/numbering-series",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("opens a series to edit; the default one cannot be deleted", async () => {
    serve([italia, svizzera]);
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Italia/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Delete series" })).toBeNull();
    expect(within(dialog).getByText(/cannot be deleted/)).toBeTruthy();
  });

  it("explains why a used series cannot be deleted", async () => {
    mocks.api.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") throw conflict("series_in_use");
      return { series: [italia, svizzera] };
    });
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Svizzera/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete series" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm delete" }));
    expect(
      await screen.findByText(/This series numbered an invoice and cannot be deleted/),
    ).toBeTruthy();
  });

  it("shows a duplicate name on the name field", async () => {
    mocks.api.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === "POST") throw conflict("series_name_taken");
      return { series: [italia] };
    });
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add series" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Italia" } });
    fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "X-" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("A series with this name already exists.")).toBeTruthy();
  });

  it("deletes an unused series", async () => {
    serve([italia, svizzera]);
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Svizzera/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete series" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith("/api/numbering-series/ch", { method: "DELETE" }),
    );
  });
});
