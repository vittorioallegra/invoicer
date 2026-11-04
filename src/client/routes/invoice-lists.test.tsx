import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceSummary } from "../../shared/invoice";
import type { InvoiceRecap } from "../../shared/invoice-filters";
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

const summary = (over: Partial<InvoiceSummary>): InvoiceSummary => ({
  id: "i1",
  source: "app",
  documentType: "TD01",
  state: "draft",
  paymentFlag: "unpaid",
  clientName: "Acme S.r.l.",
  number: null,
  issueDate: null,
  invoiceDate: null,
  dueDate: null,
  currency: "EUR",
  totalCents: 12200,
  numberReserved: false,
  releasable: false,
  linkedInvoiceId: null,
  rejectionDeadline: null,
  ...over,
});

type Lists = {
  to_issue?: InvoiceSummary[];
  issued?: InvoiceSummary[];
  reserved?: InvoiceSummary[];
  all?: InvoiceSummary[];
  years?: number[];
  recap?: InvoiceRecap;
};

function serve(lists: Lists) {
  mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
    const scope = /scope=(\w+)/.exec(path)?.[1] as keyof Lists | undefined;
    if (scope === "all") {
      return {
        invoices: lists.all ?? [],
        years: lists.years ?? [new Date().getFullYear()],
        recap: lists.recap ?? {
          count: lists.all?.length ?? 0,
          toSendCount: 0,
          byCurrency: [{ currency: "EUR", invoicedCents: 0, toCollectCents: 0, toSendCents: 0 }],
        },
      };
    }
    if (scope) return { invoices: lists[scope] ?? [] };
    if (path === "/api/clients") return { clients: [{ id: "c1", name: "Acme S.r.l." }] };
    if (path === "/api/numbering-series") {
      return {
        series: [
          { id: "default", name: "Default", isDefault: true },
          { id: "s2", name: "Credit", isDefault: false },
        ],
      };
    }
    if (path === "/api/onboarding") {
      return { checklist: [], complete: true, send: { ready: true, reasons: [] }, pecTest: null };
    }
    if (path.endsWith("/release-number") && init?.method === "POST") return { invoice: {} };
    throw new Error(`unexpected ${path}`);
  });
}

async function renderAt(path: string) {
  const i18n = await createI18n("en");
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return router;
}

beforeEach(() => {
  mocks.api.mockReset();
});
afterEach(cleanup);

describe("invoice lists", () => {
  it("shows the first-run call to action when there are no invoices at all", async () => {
    serve({});
    await renderAt("/");
    expect(await screen.findByText("No invoices yet")).toBeTruthy();
  });

  it("lists every unsent invoice under To send on Home with one status, planned or not", async () => {
    serve({
      to_issue: [
        summary({ id: "a", state: "planned", invoiceDate: "2026-12-01" }),
        summary({ id: "b", clientName: "Beta Srl" }),
      ],
    });
    await renderAt("/");
    const section = await screen.findByRole("region", { name: "To send" });
    expect(await within(section).findByText(/Acme S\.r\.l\./)).toBeTruthy();
    // One badge per row; the section title is the other match.
    expect(
      within(section)
        .getAllByText("To send")
        .filter((node) => node.tagName !== "H2"),
    ).toHaveLength(2);
    expect(within(section).queryByText(/Draft|Planned/)).toBeNull();
    expect(within(section).getByText(/Beta Srl/)).toBeTruthy();
    expect(screen.queryByText("No invoices yet")).toBeNull();
  });

  it("calls the nav item Invoices and lists every invoice with its status and payment status", async () => {
    serve({
      all: [
        summary({
          id: "a",
          state: "delivered",
          number: "7",
          issueDate: "2026-03-01",
          paymentFlag: "overdue",
        }),
        summary({ id: "b", documentType: "TD04", state: "sent", number: "8", totalCents: 5000 }),
        summary({ id: "c", clientName: "Beta Srl" }),
      ],
    });
    await renderAt("/invoices");
    expect(await screen.findByText(/No\. 7/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Invoices" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Invoices" })).toBeTruthy();
    const list = screen.getByText(/No\. 7/).closest("ul") as HTMLElement;
    expect(within(list).getByText("Delivered")).toBeTruthy();
    expect(within(list).getByText("Overdue")).toBeTruthy();
    expect(screen.getByText(/Credit note 8/)).toBeTruthy();
    expect(screen.getByText(/Beta Srl/)).toBeTruthy();
    // A credit note shows as a negative amount.
    expect(screen.getByText(/-€ 50\.00|−€ 50\.00|€ -50\.00/)).toBeTruthy();
  });

  it("shows the payment chip only on finalised payable rows, not on unsent, rejected or credit notes", async () => {
    serve({
      all: [
        summary({ id: "p", state: "delivered", number: "1", paymentFlag: "paid" }),
        summary({ id: "u", state: "sent", number: "2", paymentFlag: "unpaid" }),
        summary({ id: "d", state: "draft" }),
        summary({ id: "r", state: "rejected", number: "3" }),
        summary({ id: "x", state: "rejected_expired", number: "4" }),
        summary({ id: "c", documentType: "TD04", state: "delivered", number: "5" }),
      ],
    });
    await renderAt("/invoices");
    await screen.findByText(/No\. 1/);
    const list = screen.getByText(/No\. 1/).closest("ul") as HTMLElement;
    expect(within(list).getAllByText("Paid")).toHaveLength(1);
    expect(within(list).getAllByText("Unpaid")).toHaveLength(1);
  });

  it("keeps the old /issued address working by redirecting to /invoices", async () => {
    serve({});
    const router = await renderAt("/issued");
    expect(await screen.findByText("No invoices yet")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/invoices");
  });

  it("shows an empty state on Invoices", async () => {
    serve({});
    await renderAt("/invoices");
    expect(await screen.findByText("No invoices yet")).toBeTruthy();
  });

  it("asks the server for the filters in the URL and writes changes back to it", async () => {
    serve({ all: [summary({ id: "a", state: "delivered", number: "1" })] });
    const router = await renderAt("/invoices?year=all&status=paid&client=c1&series=s2");
    await screen.findByText(/No\. 1/);
    const call = mocks.api.mock.calls
      .map(([path]) => String(path))
      .find((p) => p.includes("scope=all"));
    const params = new URLSearchParams(call?.split("?")[1]);
    expect(Object.fromEntries(params)).toEqual({
      scope: "all",
      year: "all",
      status: "paid",
      client: "c1",
      series: "s2",
    });
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("paid");
    expect(screen.queryByLabelText("Search")).toBeNull();

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "delivered" } });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ status: "delivered" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it("defaults the year to the current Rome year and offers the years with invoices", async () => {
    serve({ all: [], years: [new Date().getFullYear(), 2024] });
    await renderAt("/invoices");
    await screen.findByText("No invoices yet");
    const year = new Date().getFullYear();
    expect(mocks.api.mock.calls.some(([p]) => String(p).includes(`year=${year}`))).toBe(true);
    const options = within(screen.getByLabelText("Year") as HTMLSelectElement)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["All years", String(year), "2024"]);
  });

  it("shows the server recap in cards, one amount per currency", async () => {
    serve({
      all: [summary({ id: "a" })],
      recap: {
        count: 3,
        toSendCount: 2,
        byCurrency: [
          { currency: "EUR", invoicedCents: 1234567, toCollectCents: 70000, toSendCents: 5000 },
          { currency: "USD", invoicedCents: 7000, toCollectCents: 0, toSendCents: 0 },
        ],
      },
    });
    await renderAt("/invoices");
    const recap = await screen.findByRole("region", { name: "Summary of the listed invoices" });
    const card = (label: string) => within(recap).getByText(label).closest("div") as HTMLElement;
    expect(within(card("Invoiced")).getByText("€ 12,345.67")).toBeTruthy();
    expect(within(card("Invoiced")).getByText("US$ 70.00")).toBeTruthy();
    expect(within(card("To collect")).getByText("€ 700.00")).toBeTruthy();
    expect(within(card("To send")).getByText("€ 50.00")).toBeTruthy();
    expect(within(card("To send")).getByText("2 invoices not sent")).toBeTruthy();
    expect(within(card("Invoices")).getByText("3")).toBeTruthy();
  });

  it("flags a number reserved but not sent and releases the highest one", async () => {
    serve({
      reserved: [
        summary({
          id: "r1",
          state: "sending",
          number: "9",
          numberReserved: true,
          releasable: true,
        }),
        summary({
          id: "r2",
          state: "sending",
          number: "4",
          numberReserved: true,
          releasable: false,
        }),
      ],
      issued: [summary({ id: "r1", state: "sending", number: "9" })],
    });
    await renderAt("/");
    const section = await screen.findByRole("region", { name: "Number reserved, not sent" });
    expect(within(section).getAllByRole("button", { name: "Release number" })).toHaveLength(1);
    expect(within(section).getByText(/must be sent/)).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Release number" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/invoices/r1/release-number",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});
