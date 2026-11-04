import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { kbToMb } from "../../shared/mailbox-quota";
import { mailboxStatusQuery } from "../lib/mailbox-api";
import { Banner } from "./ui/banner";
import { buttonVariants } from "./ui/button";

/**
 * Persistent warnings about the PEC mailbox, on every screen: a refused login (polling and
 * sending are stopped) and a quota below the threshold (a full mailbox stops incoming invoices
 * and receipts). Silent while the status cannot be read.
 */
export function MailboxAlerts() {
  const { t } = useTranslation();
  const status = useQuery(mailboxStatusQuery).data;
  const loginFailing = status?.loginFailing ?? null;
  const quota = status?.quota?.low ? status.quota : null;
  if (!loginFailing && !quota) return null;
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
      {quota ? (
        <Banner tone="warning" action={fix}>
          <p className="font-semibold">{t("mailbox.alerts.quotaTitle")}</p>
          <p>
            {t("mailbox.alerts.quotaBody", {
              free: kbToMb(quota.freeKb),
              threshold: kbToMb(status?.thresholdKb ?? 0),
            })}
          </p>
        </Banner>
      ) : null}
    </div>
  );
}
