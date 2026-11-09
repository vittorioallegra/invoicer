import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { Page } from "../components/page";
import { createI18n } from "../i18n";
import { validateInvoicesSearch } from "../routes/invoices";
import { INVOICE_LIST_BACK } from "./back-links";
import { rememberedInvoiceFilters, rememberInvoiceFilters } from "./list-memory";

afterEach(() => {
  cleanup();
  rememberInvoiceFilters({});
});

describe("remembered invoice filters", () => {
  it("returns what was remembered, and nothing by default", () => {
    expect(rememberedInvoiceFilters()).toEqual({});
    rememberInvoiceFilters({ status: "paid", year: "all" } as never);
    expect(rememberedInvoiceFilters()).toEqual({ status: "paid", year: "all" });
  });

  it("makes the back link of an invoice page return to the filtered list", async () => {
    rememberInvoiceFilters({ status: "paid", year: "all" } as never);
    const root = createRootRoute();
    const list = createRoute({
      getParentRoute: () => root,
      path: "/invoices",
      validateSearch: validateInvoicesSearch,
      component: () => <p>list</p>,
    });
    const detail = createRoute({
      getParentRoute: () => root,
      path: "/detail",
      component: () => (
        <Page title="Detail" back={INVOICE_LIST_BACK}>
          <p>body</p>
        </Page>
      ),
    });
    const router = createRouter({
      routeTree: root.addChildren([list, detail]),
      history: createMemoryHistory({ initialEntries: ["/detail"] }),
    });
    const i18n = await createI18n("en");
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient()}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nextProvider>,
    );
    const back = await screen.findByRole("link", { name: "Invoices" });
    const href = new URL(back.getAttribute("href") ?? "", "http://x");
    expect(href.pathname).toBe("/invoices");
    expect(Object.fromEntries(href.searchParams)).toEqual({ status: "paid", year: "all" });
  });
});
