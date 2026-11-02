import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "./components/app-shell";
import {
  ClientsPage,
  HomePage,
  IssuedPage,
  NewInvoicePage,
  NotFoundPage,
  ReceivedPage,
  SettingsPage,
} from "./routes/pages";
import { SpikePage } from "./routes/spike";

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFoundPage });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/issued", component: IssuedPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/received", component: ReceivedPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/clients", component: ClientsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
  // Hidden risk-spike page (step 2), removed in step 21.
  createRoute({ getParentRoute: () => rootRoute, path: "/spike", component: SpikePage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/invoices/new",
    component: NewInvoicePage,
  }),
]);

export function createAppRouter(history?: Parameters<typeof createRouter>[0]["history"]) {
  return createRouter({ routeTree, ...(history ? { history } : {}) });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
