import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(cleanup);

const ROW = {
  id: "x",
  source: "app",
  documentType: "TD01",
  state: "draft",
  paymentFlag: "unpaid",
  clientName: "Acme",
  number: null,
  issueDate: null,
  invoiceDate: null,
  dueDate: null,
  currency: "EUR",
  totalCents: 100,
  numberReserved: false,
  releasable: false,
  linkedInvoiceId: null,
  rejectionDeadline: null,
  vatCents: null,
  contributionCents: null,
};

describe("Home top strip", () => {
  it("shows the counts as links to the filtered list and the year by client with its totals", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/api/invoices/dashboard") {
        return {
          today: "2026-11-03",
          toSendCount: 2,
          rejectedCount: 1,
          overdueCount: 3,
          year: [
            { currency: "EUR", invoicedCents: 156000, vatCents: 20000, contributionCents: 4000 },
          ],
          unknownVatCount: 0,
          toCollectCents: 33000,
          toCollectCount: 2,
          monthly: Array.from({ length: 12 }, (_, index) => ({
            month: index + 1,
            currentCents: index < 11 ? 10000 : 0,
            previousCents: 20000,
          })),
          clientShares: [{ name: "Acme", invoicedCents: 156000 }],
        };
      }
      if (path.startsWith("/api/invoices?")) {
        return { invoices: [ROW] };
      }
      if (path === "/api/onboarding") {
        return { checklist: [], complete: true, send: { ready: true, reasons: [] }, pecTest: null };
      }
      throw new Error(`unexpected ${path}`);
    });
    const i18n = await createI18n("en");
    const router = createAppRouter(createMemoryHistory({ initialEntries: ["/"] }));
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nextProvider>,
    );
    const strip = await screen.findByRole("region", { name: "Overview" });
    const overdue = within(strip).getByRole("link", { name: /Overdue/ });
    expect(overdue.getAttribute("href")).toContain("status=overdue");
    expect(overdue.textContent).toContain("3");
    expect(within(strip).getByRole("link", { name: /Rejected/ }).textContent).toContain("1");
    expect(within(strip).getByText("Invoiced in 2026")).toBeTruthy();
    // The year total also heads the top client's row.
    expect(within(strip).getAllByText(/^€\s?1,560\.00$/).length).toBeGreaterThan(0);
    // Taxable amount, contribution and VAT of the year, as in the Invoices recap.
    expect(within(strip).getByText(/Taxable amount .*1,320\.00/)).toBeTruthy();
    expect(within(strip).getByText(/Contribution .*40\.00/)).toBeTruthy();
    expect(within(strip).getByText(/VAT .*200\.00/)).toBeTruthy();
    expect(within(strip).getByRole("img", { name: "Invoiced per month" })).toBeTruthy();
    expect(within(strip).getByRole("img", { name: "Invoiced since January" })).toBeTruthy();
    expect(within(strip).getByText("Acme")).toBeTruthy();
  });
});
