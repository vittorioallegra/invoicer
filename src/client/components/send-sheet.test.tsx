import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../i18n";
import { runSendFlow } from "../lib/send-flow";
import { type Preflight, SendSheet } from "./send-sheet";

vi.mock("../lib/send-flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/send-flow")>()),
  runSendFlow: vi.fn(),
}));

afterEach(cleanup);

async function show(
  number: string,
  channel?: "pec" | "manual",
  extra: { preflight?: () => Promise<Preflight>; onSent?: (id: string) => void } = {},
) {
  const i18n = await createI18n("en");
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <SendSheet
          invoiceId="i1"
          open
          onOpenChange={() => {}}
          summary={{ client: "Bianchi", total: "122.00", number }}
          onSent={extra.onSent ?? (() => {})}
          channel={channel}
          {...(extra.preflight ? { preflight: extra.preflight } : {})}
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
});

describe("SendSheet as the Finalize dialog", () => {
  it("explains the checks and, on the manual channel, that nothing is sent by the app", async () => {
    await show("", "manual", { preflight: async () => ({ ok: false, problems: [] }) });
    expect(screen.getByText("Finalize invoice")).toBeTruthy();
    const text = screen.getByText(/The invoice is checked first/).textContent ?? "";
    expect(text).toContain("AdE portal");
    expect(text).toContain("nothing is sent by the app");
    expect(screen.getByRole("button", { name: "Finalize" })).toBeTruthy();
  });

  it("lists the problems and does nothing else when a check fails", async () => {
    vi.mocked(runSendFlow).mockClear();
    const preflight = vi.fn(
      async (): Promise<Preflight> => ({
        ok: false,
        problems: [
          {
            key: "lines.0.vat",
            label: "Line 1: VAT",
            message: "Choose a VAT rate",
            field: "lines.0.vat",
          },
        ],
      }),
    );
    await show("", "pec", { preflight });
    fireEvent.click(screen.getByRole("button", { name: "Finalize and send with passkey" }));
    expect(await screen.findByText(/cannot be finalised yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Line 1: VAT" })).toBeTruthy();
    expect(runSendFlow).not.toHaveBeenCalled();
  });

  it("runs the send flow for the invoice the preflight saved when every check passes", async () => {
    vi.mocked(runSendFlow).mockResolvedValue({ messageId: "m1", fileName: "IT1_00001.xml" });
    const onSent = vi.fn();
    await show("", "manual", { preflight: async () => ({ ok: true, invoiceId: "new1" }), onSent });
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    await waitFor(() => expect(onSent).toHaveBeenCalledWith("new1"));
    expect(vi.mocked(runSendFlow).mock.calls.at(-1)?.[0]).toBe("new1");
    expect(vi.mocked(runSendFlow).mock.calls.at(-1)?.[2]).toBe("manual");
  });
});
