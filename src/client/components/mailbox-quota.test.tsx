import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxStatus } from "../../shared/mailbox-quota";
import { createI18n } from "../i18n";
import { MailboxAlerts } from "./mailbox-alerts";
import { MailboxQuota } from "./mailbox-quota";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api: mocks.api }));

const quota = (over: Partial<NonNullable<MailboxStatus["quota"]>> = {}) => ({
  usedKb: 1_000_000,
  limitKb: 1_024_000,
  freeKb: 24_000,
  source: "server" as const,
  checkedAt: 1_762_000_000_000,
  low: true,
  ...over,
});
let status: MailboxStatus;

async function show(ui: React.ReactNode, lng: "en" | "it" = "en") {
  const i18n = await createI18n(lng);
  const root = createRootRoute({ component: () => <>{ui}</> });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
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

afterEach(() => {
  cleanup();
  mocks.api.mockReset();
});

describe("mailbox alerts", () => {
  it("shows nothing while the mailbox is healthy", async () => {
    status = {
      loginFailing: null,
      quota: quota({ low: false, freeKb: 500_000 }),
      thresholdKb: 51_200,
    };
    mocks.api.mockResolvedValue(status);
    await show(<MailboxAlerts />);
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the prominent login warning and the quota banner", async () => {
    status = { loginFailing: { at: 1 }, quota: quota(), thresholdKb: 51_200 };
    mocks.api.mockResolvedValue(status);
    await show(<MailboxAlerts />);
    expect(await screen.findByText("The PEC mailbox login is failing")).toBeTruthy();
    expect(screen.getByText("The PEC mailbox is almost full")).toBeTruthy();
    expect(screen.getByText(/About 23 MB are left \(alert below 50 MB\)/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Open PEC settings" })).toHaveLength(2);
  });

  it("is written in Italian too", async () => {
    status = { loginFailing: { at: 1 }, quota: null, thresholdKb: 51_200 };
    mocks.api.mockResolvedValue(status);
    await show(<MailboxAlerts />, "it");
    expect(await screen.findByText("L'accesso alla casella PEC non funziona")).toBeTruthy();
  });
});

describe("mailbox space section", () => {
  it("says the space was never checked, and checks on demand", async () => {
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/mailbox/quota" && init?.method === "POST") {
        return {
          loginFailing: null,
          quota: quota({ low: false, source: "estimate" }),
          thresholdKb: 51_200,
        };
      }
      return { loginFailing: null, quota: null, thresholdKb: 51_200 };
    });
    await show(<MailboxQuota online configured />);
    expect(await screen.findByText(/has not been checked yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText(/976 MB used of 1000 MB, 23 MB free/)).toBeTruthy();
    expect(screen.getByText(/this is an estimate/)).toBeTruthy();
  });

  it("saves the threshold only when it changed and is valid", async () => {
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/mailbox/quota-threshold") {
        expect(JSON.parse(String(init?.body))).toEqual({ thresholdMb: 100 });
        return { loginFailing: null, quota: null, thresholdKb: 102_400 };
      }
      return { loginFailing: null, quota: null, thresholdKb: 51_200 };
    });
    await show(<MailboxQuota online configured />);
    const input = await screen.findByLabelText(/Warn when less than/);
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("50"));
    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "0" } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.click(save);
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true));
    expect(mocks.api).toHaveBeenCalledWith("/api/mailbox/quota-threshold", expect.anything());
  });
});
