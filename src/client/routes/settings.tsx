import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UiLocale } from "../../shared/format";
import { DataExport } from "../components/data-export";
import { JobsStatus } from "../components/jobs-status";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Select } from "../components/ui/select";
import { UnmatchedMessages } from "../components/unmatched-messages";
import { persistLocale } from "../i18n";
import { api } from "../lib/api";
import { saveLanguage } from "../lib/notifications-api";
import { useOnline } from "../lib/online";

interface Features {
  email: boolean;
  push: boolean;
}

const SECTIONS = [
  { to: "/settings/company", key: "profile" },
  { to: "/settings/tax", key: "tax" },
  { to: "/settings/payment-methods", key: "paymentMethods" },
  { to: "/settings/numbering", key: "numbering" },
  { to: "/recurring", key: "recurring" },
  { to: "/settings/pec", key: "pec" },
  { to: "/settings/email", key: "email" },
  { to: "/settings/notifications", key: "notifications" },
  { to: "/settings/ade-guide", key: "ade" },
  { to: "/import", key: "import" },
] as const;

function LanguageSection() {
  const { t, i18n } = useTranslation();
  return (
    <section className="space-y-2" aria-labelledby="language">
      <h2 id="language" className="text-base font-medium">
        {t("settings.language")}
      </h2>
      <div className="max-w-xs">
        <Select
          aria-labelledby="language"
          aria-describedby="language-hint"
          value={i18n.language.startsWith("it") ? "it" : "en"}
          onChange={(event) => {
            const lng = event.target.value as UiLocale;
            persistLocale(lng);
            document.documentElement.lang = lng;
            void i18n.changeLanguage(lng);
            void saveLanguage(lng);
          }}
        >
          <option value="en">English</option>
          <option value="it">Italiano</option>
        </Select>
      </div>
      <p id="language-hint" className="text-sm text-muted-foreground">
        {t("settings.languageHint")}
      </p>
    </section>
  );
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
      <nav
        aria-label={t("pages.settings.title")}
        className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface"
      >
        {SECTIONS.map(({ to, key }) => (
          <Link
            key={to}
            to={to}
            className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                {t(`settings.sections.${key}.title`)}
              </span>
              <span className="block text-sm text-muted-foreground">
                {t(`settings.sections.${key}.body`)}
              </span>
            </span>
            <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
          </Link>
        ))}
      </nav>
      <LanguageSection />
      <JobsStatus />
      <UnmatchedMessages />
      <DataExport online={online} />
    </Page>
  );
}
