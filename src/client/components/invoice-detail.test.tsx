import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_INVOICE_DATA, type InvoiceRecord } from "../../shared/invoice";
import { createI18n } from "../i18n";
import { InvoiceDetail } from "./invoice-detail";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api: mocks.api }));

const base: InvoiceRecord = {
  id: "i1",
  documentType: "TD01",
  state: "sending",
  paymentFlag: "unpaid",
  paidDate: null,
  clientId: "c1",
  clientName: "Acme",
  number: "7",
  seriesId: "default",
  requestedNumber: null,
  year: 2026,
  issueDate: "2026-03-01",
  invoiceDate: null,
  dueDate: null,
  currency: "EUR",
  totalCents: 12200,
  linkedInvoiceId: null,
  linked: null,
  reissuesInvoiceId: null,
  lines: [],
  data: EMPTY_INVOICE_DATA,
  editorForm: null,
  numberReserved: false,
  releasable: false,
  rejection: null,
  reissuedById: null,
};

const attempt = (over: object) => ({
  id: "t1",
  attempt: 1,
  fileName: "IT12345678903_00001.xml",
  channel: "pec",
  outcome: "none",
  sdiPecAddress: null,
  hasXml: true,
  hasPdf: true,
  startedAt: 1,
  ...over,
});

async function show(record: InvoiceRecord, transmissions: object) {
  mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path.endsWith("/transmissions")) return transmissions;
    if (init?.method === "POST") return { ok: true, state: "delivered" };
    throw new Error(`unexpected ${path}`);
  });
  const i18n = await createI18n("en");
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <InvoiceDetail record={record} clientName="Acme" totalLabel="EUR 122.00" />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Invoice detail panel", () => {
  it("offers PDF and XML as downloads from the Worker endpoints", async () => {
    await show(base, { attempts: [attempt({})], retry: { allowed: true, mode: "same_attempt" } });
    const pdf = (await screen.findByRole("link", { name: /Download PDF/ })) as HTMLAnchorElement;
    expect(pdf.getAttribute("href")).toBe("/api/invoices/i1/pdf");
    expect(pdf.hasAttribute("download")).toBe(true);
    expect(screen.getByRole("link", { name: /Download XML/ }).getAttribute("href")).toBe(
      "/api/invoices/i1/xml",
    );
    expect(await screen.findByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("does not offer a resend while an unknown outcome is inside the quiet period", async () => {
    await show(base, {
      attempts: [attempt({ outcome: "unknown" })],
      retry: { allowed: false, reason: "quiet_period", retryAt: Date.now() + 600_000 },
    });
    expect(await screen.findByText(/outcome is unknown/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resend with a new file name" })).toBeNull();
  });

  it("says the mailbox is checked once more after the quiet period, before a resend", async () => {
    await show(base, {
      attempts: [attempt({ outcome: "unknown" })],
      retry: { allowed: false, reason: "awaiting_poll", retryAt: Date.now() - 1000 },
    });
    expect(await screen.findByText(/checked once more/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resend with a new file name" })).toBeNull();
  });

  it("offers a resend with a new file name once the quiet period has passed", async () => {
    await show(base, {
      attempts: [attempt({ outcome: "unknown" })],
      retry: { allowed: true, mode: "new_attempt" },
    });
    expect(await screen.findByRole("button", { name: "Resend with a new file name" })).toBeTruthy();
  });

  it("records a manual portal outcome", async () => {
    await show(
      { ...base, state: "sent" },
      {
        attempts: [attempt({ outcome: "complete", channel: "manual" })],
        retry: { allowed: false, reason: "not_sendable" },
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delivered" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/invoices/i1/manual/outcome",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("leads with Mark paid once the invoice is delivered", async () => {
    await show(
      { ...base, state: "delivered" },
      {
        attempts: [attempt({ outcome: "complete" })],
        retry: { allowed: false, reason: "not_sendable" },
      },
    );
    expect(await screen.findByRole("button", { name: "Mark paid" })).toBeTruthy();
  });
});
