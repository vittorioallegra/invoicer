import { Link } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Page } from "../components/page";
import { buttonVariants } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";

/** Placeholder pages: each later step replaces its own screen. */

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
