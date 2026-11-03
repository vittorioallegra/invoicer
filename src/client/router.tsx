import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import { AppShell } from "./components/app-shell";
import { SessionGate } from "./components/session-gate";
import { AdeGuidePage } from "./routes/ade-guide";
import { ClientsPage } from "./routes/clients";
import { EmailSettingsPage } from "./routes/email-settings";
import { HomePage } from "./routes/home";
import { InvoiceEditorPage } from "./routes/invoice-editor";
import { LoginPage } from "./routes/login";
import { IssuedPage, NotFoundPage, ReceivedPage } from "./routes/pages";
import { PecSettingsPage } from "./routes/pec-settings";
import { ProfilePage } from "./routes/profile";
import { SettingsPage } from "./routes/settings";
import { SetupPage } from "./routes/setup";
import { SpikePage } from "./routes/spike";

/** Screens without the app shell and without a session: login and first-run setup. */
const BARE_PATHS = new Set(["/login", "/setup"]);

/** Every other screen needs a session; the temporary spike page has its own secret header. */
function Root() {
  const pathname = useLocation({ select: (location) => location.pathname });
  if (BARE_PATHS.has(pathname)) return <Outlet />;
  if (pathname === "/spike") return <AppShell />;
  return (
    <SessionGate>
      <AppShell />
    </SessionGate>
  );
}

const rootRoute = createRootRoute({ component: Root, notFoundComponent: NotFoundPage });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/issued", component: IssuedPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/received", component: ReceivedPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/clients", component: ClientsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/company",
    component: ProfilePage,
  }),
  // Former path of the Company page.
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/profile",
    beforeLoad: () => {
      throw redirect({ to: "/settings/company", replace: true });
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/pec",
    component: PecSettingsPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/email",
    component: EmailSettingsPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/ade-guide",
    component: AdeGuidePage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/setup", component: SetupPage }),
  // Hidden risk-spike page (step 2), removed in step 21.
  createRoute({ getParentRoute: () => rootRoute, path: "/spike", component: SpikePage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/invoices/new",
    component: InvoiceEditorPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/invoices/$invoiceId",
    component: InvoiceEditorPage,
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
