import { Link } from "@tanstack/react-router";
import { FileText, Inbox } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Page } from "../components/page";
import { buttonVariants } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";

/** Placeholder pages: each later step replaces its own screen. */

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
