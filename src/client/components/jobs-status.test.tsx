import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../i18n";
import { JobsStatus } from "./jobs-status";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api: mocks.api }));

async function show(data: unknown, lng: "en" | "it" = "en") {
  mocks.api.mockResolvedValue(data);
  const i18n = await createI18n(lng);
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <JobsStatus />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.api.mockReset();
});

describe("background jobs status", () => {
  it("says when nothing has run yet", async () => {
    await show({ poll: null, daily: null });
    expect((await screen.findAllByText("Has not run yet")).length).toBe(2);
  });

  it("shows the last runs, what the daily run did and a failed task", async () => {
    await show({
      poll: {
        at: 1_762_000_000_000,
        runDate: "2026-11-01",
        status: "success",
        errorCode: null,
        counts: null,
      },
      daily: {
        at: 1_762_000_000_000,
        runDate: "2026-11-01",
        status: "failed",
        errorCode: "daily_failed",
        counts: { unsent: 0, overdue: 2, recurring: -1 },
      },
    });
    expect(await screen.findByText(/failed \(daily_failed\)/)).toBeTruthy();
    expect(screen.getByText(/2 overdue alerts/)).toBeTruthy();
    expect(screen.getByText(/Recurring invoices: failed/)).toBeTruthy();
    expect(screen.queryByText(/unsent invoice reminder/)).toBeNull();
  });
});
