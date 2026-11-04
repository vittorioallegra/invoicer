import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Circle, FileText, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChecklistItemId, OnboardingStatus } from "../../shared/onboarding";
import { DashboardStrip } from "../components/dashboard-strip";
import { InvoiceList, ReservedList } from "../components/invoice-list";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button, buttonVariants } from "../components/ui/button";
import { Disclosure } from "../components/ui/disclosure";
import { EmptyState } from "../components/ui/empty-state";
import { invoicesQuery } from "../lib/invoices-api";
import { onboardingQuery } from "../lib/settings-api";

/** Where each pending item is fixed. Passkey and TOTP resume the setup flow of the signed-in owner. */
const TARGETS: Record<ChecklistItemId, string> = {
  passkey: "/setup",
  fallback_login: "/setup",
  profile: "/settings/company",
  pec: "/settings/pec",
  ade_guide: "/settings/ade-guide",
  email: "/settings/email",
};

const CHECKLIST_OPEN_KEY = "invoicer.setupChecklistOpen";

/** The remembered open state of this device; open while there is no (readable) choice. */
function readChecklistOpen(): boolean {
  try {
    return localStorage.getItem(CHECKLIST_OPEN_KEY) !== "closed";
  } catch {
    return true;
  }
}

function Checklist({ status }: { status: OnboardingStatus }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(readChecklistOpen);
  const done = status.checklist.filter((item) => item.done).length;
  const progress = t("onboarding.progress", { done, total: status.checklist.length });
  function toggle() {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(CHECKLIST_OPEN_KEY, next ? "open" : "closed");
    } catch {
      // Private mode or blocked storage: the choice just is not remembered.
    }
  }
  return (
    <Disclosure
      id="setup-checklist"
      title={t("onboarding.title")}
      summary={progress}
      open={open}
      onToggle={toggle}
      flush
    >
      <p className="px-4 py-2 text-sm text-muted-foreground">{progress}</p>
      <ul className="divide-y divide-border">
        {status.checklist.map((item) => (
          <li key={item.id}>
            <Link
              to={TARGETS[item.id]}
              className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-muted"
            >
              {item.done ? (
                <Check aria-hidden className="size-5 shrink-0 text-success" />
              ) : (
                <Circle aria-hidden className="size-5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {t(`onboarding.items.${item.id}.title`)}
                </span>
                <span className="block text-sm text-muted-foreground">
                  {t(`onboarding.items.${item.id}.body`)}
                </span>
              </span>
              <span
                className={item.done ? "text-sm text-success" : "text-sm text-muted-foreground"}
              >
                {item.done ? t("onboarding.done") : t("onboarding.pending")}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

function SendBlocked({ status }: { status: OnboardingStatus }) {
  const { t } = useTranslation();
  if (status.send.ready) return null;
  return (
    <Banner tone="warning" className="max-w-2xl">
      <p className="font-medium">{t("onboarding.sendBlocked")}</p>
      <ul className="list-disc pl-5">
        {status.send.reasons.map((reason) => (
          <li key={reason}>{t(`onboarding.reasons.${reason}`)}</li>
        ))}
      </ul>
    </Banner>
  );
}

export function HomePage() {
  const { t } = useTranslation();
  const query = useQuery(onboardingQuery);
  const status = query.data;
  // First run: the call to action leads to the first thing to fix, then to the editor.
  const profileMissing = status?.send.reasons.includes("profile_incomplete");
  const toIssue = useQuery(invoicesQuery("to_issue"));
  const issued = useQuery(invoicesQuery("issued"));
  const noInvoices = toIssue.data?.invoices.length === 0 && issued.data?.invoices.length === 0;

  return (
    <Page title={t("pages.home.title")}>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {query.isError ? (
        <Banner
          tone="danger"
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              {t("common.retry")}
            </Button>
          }
        >
          {t("common.error")}
        </Banner>
      ) : null}
      {status && !status.complete ? <Checklist status={status} /> : null}
      {status ? <SendBlocked status={status} /> : null}
      {noInvoices ? null : <DashboardStrip />}
      <ReservedList />
      {noInvoices ? (
        <EmptyState
          icon={FileText}
          title={t("pages.home.emptyTitle")}
          description={
            profileMissing ? t("pages.home.emptyBodyProfile") : t("pages.home.emptyBody")
          }
          action={
            profileMissing ? (
              <Link to="/settings/company" className={buttonVariants()}>
                {t("pages.home.profileAction")}
              </Link>
            ) : (
              <Link to="/invoices/new" className={buttonVariants()}>
                <Plus aria-hidden />
                {t("pages.home.emptyAction")}
              </Link>
            )
          }
        />
      ) : (
        <section aria-labelledby="to-issue-title" className="flex flex-col gap-2">
          <h2 id="to-issue-title" className="text-base font-semibold">
            {t("invoice.list.toSendTitle")}
          </h2>
          <InvoiceList
            scope="to_issue"
            empty={<p className="text-sm text-muted-foreground">{t("invoice.list.toSendEmpty")}</p>}
          />
        </section>
      )}
    </Page>
  );
}
