import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { Bell, FileText, House, Inbox, Settings, Users, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { notificationsQuery } from "../lib/notifications-api";
import { useOnline } from "../lib/online";
import { cn } from "../lib/utils";
import { MailboxAlerts } from "./mailbox-alerts";
import { NewInvoiceLink } from "./new-invoice-link";
import { Banner } from "./ui/banner";
import { Toaster } from "./ui/toast";

const NAV = [
  { to: "/", key: "home", icon: House },
  { to: "/invoices", key: "invoices", icon: FileText },
  { to: "/received", key: "received", icon: Inbox },
  { to: "/clients", key: "clients", icon: Users },
  { to: "/settings", key: "settings", icon: Settings },
] as const;

/** Link to the notification list with the unread count (the same query keeps it fresh). */
function NotificationsLink({ className }: { className?: string }) {
  const { t } = useTranslation();
  const unread = useQuery(notificationsQuery).data?.unread ?? 0;
  return (
    <Link
      to="/notifications"
      aria-label={
        unread > 0
          ? t("notificationsPage.linkUnread", { count: unread })
          : t("notificationsPage.title")
      }
      className={cn(
        "relative flex size-11 items-center justify-center rounded-control text-muted-foreground hover:bg-muted",
        className,
      )}
      activeProps={{ className: "bg-muted text-foreground", "aria-current": "page" }}
    >
      <Bell aria-hidden className="size-5" />
      {unread > 0 ? (
        <span
          aria-hidden
          className="absolute top-1 right-1 min-w-4 rounded-full bg-primary px-1 text-center text-[0.625rem] leading-4 font-semibold text-primary-foreground"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </Link>
  );
}

/** Mac / wide screens: sidebar. */
function Sidebar() {
  const { t } = useTranslation();
  return (
    <aside className="hidden w-60 shrink-0 flex-col gap-6 overflow-y-auto border-r border-border bg-surface p-4 md:sticky md:top-0 md:flex md:h-dvh md:self-start">
      <div className="flex items-center justify-between pt-2 pl-2">
        <span className="text-lg font-semibold">{t("app.name")}</span>
        <NotificationsLink />
      </div>
      <NewInvoiceLink />
      <nav aria-label={t("nav.label")} className="flex flex-col gap-1">
        {NAV.map(({ to, key, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact: to === "/" || to === "/invoices", includeSearch: false }}
            className="flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-medium text-muted-foreground hover:bg-muted"
            activeProps={{ className: "bg-muted text-foreground", "aria-current": "page" }}
          >
            <Icon aria-hidden className="size-5" />
            {t(`nav.${key}`)}
          </Link>
        ))}
      </nav>
    </aside>
  );
}

/** iPhone: bottom tab bar with safe-area padding. */
function BottomTabs() {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("nav.label")}
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 transform-gpu border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {NAV.map(({ to, key, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          activeOptions={{ exact: to === "/" || to === "/invoices", includeSearch: false }}
          className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium text-muted-foreground"
          activeProps={{ className: "text-primary", "aria-current": "page" }}
        >
          <Icon aria-hidden className="size-5" />
          {t(`nav.${key}`)}
        </Link>
      ))}
    </nav>
  );
}

function OfflineBanner() {
  const { t } = useTranslation();
  const online = useOnline();
  if (online) return null;
  return (
    <div className="px-4 pt-4 md:px-8">
      <Banner tone="warning" action={<WifiOff aria-hidden className="size-4" />}>
        {t("offline.banner")}
      </Banner>
    </div>
  );
}

export function AppShell() {
  return (
    <div className="flex min-h-dvh pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          aria-hidden
          data-testid="safe-area-top"
          className="h-[env(safe-area-inset-top)] shrink-0"
        />
        <div className="flex justify-end px-4 pt-1 md:hidden">
          <NotificationsLink />
        </div>
        <OfflineBanner />
        <MailboxAlerts />
        <main className="flex-1 px-4 py-6 pb-[calc(8rem+env(safe-area-inset-bottom))] md:px-8 md:pb-8">
          <div className="mx-auto w-full max-w-4xl">
            <Outlet />
          </div>
        </main>
      </div>
      <BottomTabs />
      <Toaster />
    </div>
  );
}
