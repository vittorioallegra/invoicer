import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecurringList, RecurringTemplateRecord } from "../../shared/recurring";
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

const template = (over: Partial<RecurringTemplateRecord> = {}): RecurringTemplateRecord => ({
  id: "t1",
  clientId: "c1",
  clientName: "Acme S.r.l.",
  intervalMonths: 3,
  dayOfMonth: 15,
  startDate: "2026-01-15",
  endDate: null,
  maxCount: null,
  paused: false,
  lineCount: 1,
  totalCents: 122_000,
  currency: "EUR",
  createdCount: 2,
  nextDate: "2026-10-15",
  ...over,
});

let list: RecurringList;

beforeEach(() => {
  list = { templates: [], leadDays: 3 };
  mocks.api.mockReset();
  mocks.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/api/recurring" && !init?.method) return list;
    if (path === "/api/recurring/t1/paused") {
      list = {
        ...list,
        templates: [template({ paused: JSON.parse(init?.body ?? "{}").paused === true })],
      };
      return list;
    }
    if (path === "/api/recurring/t1" && init?.method === "DELETE") {
      list = { ...list, templates: [] };
      return list;
    }
    if (path === "/api/recurring/lead-days") {
      list = { ...list, leadDays: JSON.parse(init?.body ?? "{}").days };
      return list;
    }
    return { unread: 0, notifications: [] };
  });
});
afterEach(cleanup);

async function renderPage(lng: "en" | "it" = "en") {
  const i18n = await createI18n(lng);
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/recurring"] }));
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

describe("Recurring invoices page", () => {
  it("explains how to create one when there are none", async () => {
    await renderPage();
    expect(await screen.findByText("No recurring invoices yet")).toBeTruthy();
    expect(screen.getByText(/Repeat on a schedule/)).toBeTruthy();
  });

  it("lists a template with its cadence, total, next date and progress", async () => {
    list = { templates: [template()], leadDays: 3 };
    await renderPage();
    const row = (await screen.findAllByRole("listitem"))[0] as HTMLElement;
    expect(within(row).getByText("Acme S.r.l.")).toBeTruthy();
    expect(within(row).getByText(/Every 3 months on day 15/)).toBeTruthy();
    expect(within(row).getByText(/Next invoice dated/)).toBeTruthy();
    expect(within(row).getByText(/2 invoices created so far/)).toBeTruthy();
    expect(within(row).getByText(/1.220,00|1,220.00/)).toBeTruthy();
  });

  it("is available in Italian", async () => {
    list = { templates: [template({ intervalMonths: 1, paused: true })], leadDays: 3 };
    await renderPage("it");
    expect(await screen.findByText(/Ogni mese il giorno 15/)).toBeTruthy();
    expect(screen.getByText(/In pausa/)).toBeTruthy();
  });

  it("pauses and resumes a template", async () => {
    list = { templates: [template()], leadDays: 3 };
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.getByText(/Paused: no invoice is created/)).toBeTruthy();
  });

  it("asks for confirmation before deleting and then shows the empty state", async () => {
    list = { templates: [template()], leadDays: 3 };
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this recurring invoice?" });
    expect(mocks.api).not.toHaveBeenCalledWith(
      "/api/recurring/t1",
      expect.objectContaining({ method: "DELETE" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No recurring invoices yet")).toBeTruthy();
  });

  it("edits the schedule and saves it only when it changed and is valid", async () => {
    list = { templates: [template()], leadDays: 3 };
    mocks.api.mockImplementation(
      async (path: string, init?: { method?: string; body?: string }) => {
        if (path === "/api/recurring/t1" && init?.method === "PUT") {
          expect(JSON.parse(init.body ?? "{}")).toMatchObject({
            dayOfMonth: 20,
            intervalMonths: 3,
          });
          list = { ...list, templates: [template({ dayOfMonth: 20 })] };
          return list;
        }
        return path === "/api/recurring" ? list : { unread: 0, notifications: [] };
      },
    );
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit schedule" }));
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const day = within(dialog).getByLabelText(/Day of the month/);
    fireEvent.change(day, { target: { value: "40" } });
    expect(save.disabled).toBe(true);
    expect(within(dialog).getByRole("alert")).toBeTruthy();
    fireEvent.change(day, { target: { value: "20" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/Every 3 months on day 20/)).toBeTruthy();
  });

  it("saves the lead time", async () => {
    list = { templates: [], leadDays: 3 };
    await renderPage();
    const input = (await screen.findByLabelText(
      /Create each invoice this many days ahead/,
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("3"));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/recurring/lead-days",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
  });
});
