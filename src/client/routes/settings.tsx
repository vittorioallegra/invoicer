import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../shared/errors";
import type { UiLocale } from "../../shared/format";
import { DataExport } from "../components/data-export";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { UnmatchedMessages } from "../components/unmatched-messages";
import { persistLocale } from "../i18n";
import { api } from "../lib/api";
import { useOnline } from "../lib/online";
import { putJson, settingsQuery } from "../lib/settings-api";

interface Features {
  email: boolean;
  push: boolean;
}

const SECTIONS = [
  { to: "/settings/company", key: "profile" },
  { to: "/settings/pec", key: "pec" },
  { to: "/settings/email", key: "email" },
  { to: "/settings/ade-guide", key: "ade" },
] as const;

function LanguageSection() {
  const { t, i18n } = useTranslation();
  return (
    <section className="space-y-2" aria-labelledby="language">
      <h2 id="language" className="text-base font-medium">
        {t("settings.language")}
      </h2>
      <Field
        label={t("settings.languageLabel")}
        hint={t("settings.languageHint")}
        className="max-w-xs"
      >
        {(c) => (
          <Select
            {...c}
            value={i18n.language.startsWith("it") ? "it" : "en"}
            onChange={(event) => {
              const lng = event.target.value as UiLocale;
              persistLocale(lng);
              document.documentElement.lang = lng;
              void i18n.changeLanguage(lng);
            }}
          >
            <option value="en">English</option>
            <option value="it">Italiano</option>
          </Select>
        )}
      </Field>
    </section>
  );
}

function NumberingSection({ online }: { online: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery(settingsQuery);
  const numbering = query.data?.invoiceNumber;
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (numbering) setValue(String(numbering.next));
  }, [numbering]);

  const save = useMutation({
    mutationFn: (number: number) => putJson("/api/settings/invoice-number", { number }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (failure) => {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? t("settings.numberBelowUsed", { minimum: numbering?.minimum })
          : t("common.error"),
      );
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    const number = Number(value);
    if (!/^\d+$/.test(value.trim()) || number < 1) {
      setError(t("settings.numberInvalid"));
      return;
    }
    if (numbering && number < numbering.minimum) {
      setError(t("settings.numberBelowUsed", { minimum: numbering.minimum }));
      return;
    }
    setError(undefined);
    save.mutate(number);
  }

  if (!numbering) return null;
  return (
    <section className="space-y-2" aria-labelledby="numbering">
      <h2 id="numbering" className="text-base font-medium">
        {t("settings.numberingTitle", { year: numbering.year })}
      </h2>
      <p className="text-sm text-muted-foreground">{t("settings.numberingIntro")}</p>
      <form onSubmit={onSubmit} noValidate className="flex max-w-xs flex-col gap-3">
        <Field label={t("settings.nextNumber")} error={error}>
          {(c) => (
            <Input
              {...c}
              value={value}
              inputMode="numeric"
              onChange={(event) => {
                setSaved(false);
                setValue(event.target.value);
              }}
            />
          )}
        </Field>
        <Button type="submit" disabled={!online || save.isPending} className="w-fit">
          {t("settings.saveNumber")}
        </Button>
        {saved ? <Banner tone="success">{t("settings.numberSaved")}</Banner> : null}
      </form>
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
        className="max-w-2xl divide-y divide-border rounded-card border border-border bg-surface"
      >
        {SECTIONS.map(({ to, key }) => (
          <Link
            key={to}
            to={to}
            className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-muted"
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
      <NumberingSection online={online} />
      <UnmatchedMessages />
      <DataExport online={online} />
      {/* Temporary: removed together with the spike page (plan step 21). A plain anchor, not
          a router link: /spike is a separate hidden page outside the app shell. */}
      <p className="pt-4 text-sm">
        <a href="/spike" className="text-muted-foreground underline underline-offset-4">
          {t("pages.settings.diagnostics")}
        </a>
      </p>
    </Page>
  );
}
