import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Page } from "../components/page";
import { buttonVariants } from "../components/ui/button";

/** Placeholder pages: each later step replaces its own screen. */

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
