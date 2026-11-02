import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../i18n";
import { UnmatchedMessages } from "./unmatched-messages";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api: mocks.api }));

async function show(messages: unknown[], lng: "en" | "it" = "en") {
  mocks.api.mockResolvedValue({ messages });
  const i18n = await createI18n(lng);
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <UnmatchedMessages />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.api.mockReset();
});

describe("unmatched SdI messages", () => {
  it("shows an empty state", async () => {
    await show([]);
    expect(await screen.findByText(/No unmatched messages/)).toBeTruthy();
  });

  it("lists type and file name as text, in Italian too", async () => {
    await show(
      [{ id: "m1", type: "NS", fileName: "<b>IT1_0000A.xml</b>", receivedAt: 1_762_000_000_000 }],
      "it",
    );
    expect(await screen.findByText("<b>IT1_0000A.xml</b>")).toBeTruthy();
    expect(screen.getByText("NS")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Messaggi del SdI/ })).toBeTruthy();
  });
});
