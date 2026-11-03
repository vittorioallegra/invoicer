import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../i18n";
import { SendSheet } from "./send-sheet";

vi.mock("../lib/send-flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/send-flow")>()),
  runSendFlow: vi.fn(),
}));

afterEach(cleanup);

async function show(number: string, channel?: "pec" | "manual") {
  const i18n = await createI18n("en");
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <SendSheet
          invoiceId="i1"
          open
          onOpenChange={() => {}}
          summary={{ client: "Bianchi", total: "122.00", number }}
          onSent={() => {}}
          channel={channel}
        />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("SendSheet review text", () => {
  it("says a number will be reserved for an invoice without one, with no empty number", async () => {
    await show("");
    const text = screen.getByText(/New invoice to Bianchi/).textContent ?? "";
    expect(text).toContain("a number is reserved");
    expect(text).not.toContain("  ");
  });

  it("states that the reserved number is used when the invoice already has one", async () => {
    await show("7");
    const text = screen.getByText(/Invoice 7 to Bianchi/).textContent ?? "";
    expect(text).toContain("the reserved number 7 is used");
    expect(text).not.toContain("a number is reserved");
  });

  it("does not mention the SdI hand-over on the manual channel", async () => {
    await show("", "manual");
    expect(screen.getByText(/New invoice to Bianchi/).textContent).toContain("AdE portal");
  });
});
