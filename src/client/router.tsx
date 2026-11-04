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
import { ImportPage, validateImportSearch } from "./routes/import";
import { InvoiceEditorPage } from "./routes/invoice-editor";
import { InvoicePage } from "./routes/invoice-page";
import { InvoicesPage, validateInvoicesSearch } from "./routes/invoices";
import { LoginPage } from "./routes/login";
import { NotificationSettingsPage } from "./routes/notification-settings";
import { NotificationsPage } from "./routes/notifications";
import { NumberingPage } from "./routes/numbering";
import { NotFoundPage } from "./routes/pages";
import { PaymentMethodsPage } from "./routes/payment-methods";
import { PecSettingsPage } from "./routes/pec-settings";
import { ProfilePage } from "./routes/profile";
import { ReceivedPage } from "./routes/received";
import { ReceivedDetailPage } from "./routes/received-detail";
import { SettingsPage } from "./routes/settings";
import { SetupPage } from "./routes/setup";
import { TaxPage } from "./routes/tax";

/** Screens without the app shell and without a session: login and first-run setup. */
const BARE_PATHS = new Set(["/login", "/setup"]);

/** Every other screen needs a session. */
function Root() {
  const pathname = useLocation({ select: (location) => location.pathname });
  if (BARE_PATHS.has(pathname)) return <Outlet />;
  return (
    <SessionGate>
      <AppShell />
    </SessionGate>
  );
}

const rootRoute = createRootRoute({ component: Root, notFoundComponent: NotFoundPage });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/invoices",
    validateSearch: validateInvoicesSearch,
    component: InvoicesPage,
  }),
  // Former path of the Invoices page (then "Issued").
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/issued",
    beforeLoad: () => {
      throw redirect({ to: "/invoices", replace: true });
    },
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/received", component: ReceivedPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/received/$receivedId",
    component: ReceivedDetailPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/clients", component: ClientsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/import",
    validateSearch: validateImportSearch,
    component: ImportPage,
  }),
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
  createRoute({ getParentRoute: () => rootRoute, path: "/settings/tax", component: TaxPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/payment-methods",
    component: PaymentMethodsPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/numbering",
    component: NumberingPage,
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
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    // `reason=idle`: the owner was signed out for inactivity (see `lib/sign-out.ts`).
    validateSearch: (search: Record<string, unknown>): { reason?: "idle" } =>
      search.reason === "idle" ? { reason: "idle" } : {},
    component: LoginPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/setup", component: SetupPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/notifications",
    component: NotificationsPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/notifications",
    component: NotificationSettingsPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/invoices/new",
    component: InvoiceEditorPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/invoices/$invoiceId",
    component: InvoicePage,
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
