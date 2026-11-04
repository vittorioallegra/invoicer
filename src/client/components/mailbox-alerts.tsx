import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { mailboxStatusQuery } from "../lib/mailbox-api";
import { Banner } from "./ui/banner";
import { buttonVariants } from "./ui/button";

/**
 * Persistent warning about the PEC mailbox, on every screen: a refused login (polling and
 * sending are stopped). Silent while the status cannot be read.
 */
export function MailboxAlerts() {
  const { t } = useTranslation();
  const status = useQuery(mailboxStatusQuery).data;
  const loginFailing = status?.loginFailing ?? null;
  if (!loginFailing) return null;
  const fix = (
    <Link to="/settings/pec" className={buttonVariants({ size: "sm", variant: "secondary" })}>
      {t("mailbox.alerts.open")}
    </Link>
  );
  return (
    <div className="space-y-2 px-4 pt-4 md:px-8">
      {loginFailing ? (
        <Banner tone="danger" action={fix}>
          <p className="font-semibold">{t("mailbox.alerts.loginTitle")}</p>
          <p>{t("mailbox.alerts.loginBody")}</p>
        </Banner>
      ) : null}
    </div>
  );
}
