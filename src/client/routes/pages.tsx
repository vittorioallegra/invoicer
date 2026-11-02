import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText, Inbox, Plus, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { buttonVariants } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { api } from "../lib/api";
import { useOnline } from "../lib/online";

/** Placeholder pages: each later step replaces its own screen. */

export function HomePage() {
  const { t } = useTranslation();
  return (
    <Page title={t("pages.home.title")}>
      <EmptyState
        icon={FileText}
        title={t("pages.home.emptyTitle")}
        description={t("pages.home.emptyBody")}
        action={
          <Link to="/invoices/new" className={buttonVariants()}>
            <Plus aria-hidden />
            {t("pages.home.emptyAction")}
          </Link>
        }
      />
    </Page>
  );
}

export function IssuedPage() {
  const { t } = useTranslation();
  return (
    <Page title={t("pages.issued.title")}>
      <EmptyState
        icon={FileText}
        title={t("pages.issued.emptyTitle")}
        description={t("pages.issued.emptyBody")}
      />
    </Page>
  );
}

export function ReceivedPage() {
  const { t } = useTranslation();
  return (
    <Page title={t("pages.received.title")}>
      <EmptyState
        icon={Inbox}
        title={t("pages.received.emptyTitle")}
        description={t("pages.received.emptyBody")}
      />
    </Page>
  );
}

export function ClientsPage() {
  const { t } = useTranslation();
  return (
    <Page title={t("pages.clients.title")}>
      <EmptyState
        icon={Users}
        title={t("pages.clients.emptyTitle")}
        description={t("pages.clients.emptyBody")}
      />
    </Page>
  );
}

export function NewInvoicePage() {
  const { t } = useTranslation();
  return (
    <Page title={t("pages.newInvoice.title")}>
      <EmptyState
        icon={FileText}
        title={t("pages.newInvoice.emptyTitle")}
        description={t("pages.newInvoice.emptyBody")}
      />
    </Page>
  );
}

interface Features {
  email: boolean;
  push: boolean;
}

export function SettingsPage() {
  const { t } = useTranslation();
  const online = useOnline();
  const features = useQuery({
    queryKey: ["features"],
    queryFn: () => api<Features>("/api/features"),
  });
  return (
    <Page title={t("pages.settings.title")}>
      {!online ? <Banner tone="warning">{t("offline.reason")}</Banner> : null}
      {features.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {features.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {features.data && !features.data.email ? (
        <Banner tone="info">{t("features.emailOff")}</Banner>
      ) : null}
      {features.data && !features.data.push ? (
        <Banner tone="info">{t("features.pushOff")}</Banner>
      ) : null}
    </Page>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <Page title={t("pages.notFound.title")}>
      <p className="text-muted-foreground">{t("pages.notFound.body")}</p>
      <Link to="/" className={buttonVariants({ variant: "secondary", className: "w-fit" })}>
        {t("pages.notFound.action")}
      </Link>
    </Page>
  );
}
