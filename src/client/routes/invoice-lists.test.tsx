import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceSummary } from "../../shared/invoice";
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
  documentType: "TD01",
  state: "draft",
  paymentFlag: "unpaid",
  clientName: "Acme S.r.l.",
  number: null,
  issueDate: null,
  plannedDate: null,
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
};

function serve(lists: Lists) {
  mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
    const scope = /scope=(\w+)/.exec(path)?.[1] as keyof Lists | undefined;
    if (scope) return { invoices: lists[scope] ?? [] };
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

  it("lists drafts and planned invoices under To issue on Home", async () => {
    serve({
      to_issue: [
        summary({ id: "a", state: "planned", plannedDate: "2026-12-01" }),
        summary({ id: "b", clientName: "Beta Srl" }),
      ],
    });
    await renderAt("/");
    const section = await screen.findByRole("region", { name: "To issue" });
    expect(await within(section).findByText(/Acme S\.r\.l\./)).toBeTruthy();
    expect(within(section).getByText("Planned")).toBeTruthy();
    expect(within(section).getByText(/Beta Srl/)).toBeTruthy();
    expect(screen.queryByText("No invoices yet")).toBeNull();
  });

  it("lists numbered invoices on Issued with their SdI and payment status", async () => {
    serve({
      issued: [
        summary({
          id: "a",
          state: "delivered",
          number: "7",
          issueDate: "2026-03-01",
          paymentFlag: "overdue",
        }),
        summary({ id: "b", documentType: "TD04", state: "sent", number: "8", totalCents: 5000 }),
      ],
    });
    await renderAt("/issued");
    expect(await screen.findByText(/No\. 7/)).toBeTruthy();
    expect(screen.getByText("Delivered")).toBeTruthy();
    expect(screen.getByText("Overdue")).toBeTruthy();
    expect(screen.getByText(/Credit note 8/)).toBeTruthy();
    // A credit note shows as a negative amount.
    expect(screen.getByText(/-€50\.00|−€50\.00|€-50\.00/)).toBeTruthy();
  });

  it("shows an empty state on Issued", async () => {
    serve({});
    await renderAt("/issued");
    expect(await screen.findByText("No issued invoices")).toBeTruthy();
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
