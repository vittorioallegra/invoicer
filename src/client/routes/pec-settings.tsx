import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type PecTestResult, type PecTestStages, stagesFromTest } from "../../shared/onboarding";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { toast } from "../components/ui/toast";
import { api } from "../lib/api";
import { SETTINGS_BACK } from "../lib/back-links";
import { useOnline } from "../lib/online";
import { putJson, settingsQuery } from "../lib/settings-api";
import { useDirty } from "../lib/use-dirty";

interface Features {
  pec: { username: boolean; password: boolean };
}

const STAGES = ["imapLogin", "mailbox", "quota", "smtpLogin"] as const;

function StageList({ stages }: { stages: PecTestStages }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-1 text-sm" aria-label={t("pec.stagesLabel")}>
      {STAGES.map((stage) => (
        <li key={stage}>
          {t(`pec.stages.${stage}`)}: <strong>{t(`pec.stageResult.${stages[stage]}`)}</strong>
        </li>
      ))}
    </ul>
  );
}

function TestResult({ result }: { result: PecTestResult | null }) {
  const { t, i18n } = useTranslation();
  if (!result) return <Banner tone="info">{t("settings.pecNeverTested")}</Banner>;
  const when = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(result.at));
  const quota = result.quota;
  return (
    <div className="space-y-2">
      {result.ok ? (
        <Banner tone="success">{t("settings.pecTestPassed", { when })}</Banner>
      ) : (
        <Banner tone="danger">
          {t("settings.pecTestFailed", { when })}{" "}
          {t(`settings.pecErrors.${result.error ?? "connection_failed"}`)}
        </Banner>
      )}
      <StageList stages={result.stages ?? stagesFromTest(result)} />
      {quota ? (
        <p className="text-sm text-muted-foreground">
          {t("pec.quota", {
            used: Math.round(quota.usedKb / 1024),
            limit: Math.round(quota.limitKb / 1024),
          })}
        </p>
      ) : null}
    </div>
  );
}

const EMPTY_SERVERS = { imapHost: "", imapPort: "", smtpHost: "", smtpPort: "" };

function ServersForm({ online }: { online: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery(settingsQuery);
  const [form, setForm] = useState(EMPTY_SERVERS);
  const { dirty, markSaved } = useDirty(EMPTY_SERVERS, form);
  const servers = query.data?.pec.servers;
  useEffect(() => {
    if (servers) {
      const loaded = {
        imapHost: servers.imapHost,
        imapPort: String(servers.imapPort),
        smtpHost: servers.smtpHost,
        smtpPort: String(servers.smtpPort),
      };
      setForm(loaded);
      markSaved(loaded);
    }
  }, [servers, markSaved]);

  const save = useMutation({
    mutationFn: (submitted: typeof form) =>
      putJson("/api/settings/pec-servers", {
        imapHost: submitted.imapHost.trim(),
        imapPort: Number(submitted.imapPort),
        smtpHost: submitted.smtpHost.trim(),
        smtpPort: Number(submitted.smtpPort),
      }),
    onSuccess: (_data, submitted) => {
      markSaved(submitted);
      toast.success(t("pec.serversSaved"));
    },
    onError: () => toast.error(t("pec.serversInvalid")),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["onboarding"] }),
      ]);
    },
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm({ ...form, [key]: event.target.value });
  const preset = query.data?.pec.preset;

  return (
    <form
      className="space-y-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save.mutate(form);
      }}
    >
      <h2 className="text-base font-medium">{t("pec.serversTitle")}</h2>
      <p className="text-sm text-muted-foreground">{t("pec.serversHint")}</p>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label={t("pec.imapHost")}>
          {(c) => <Input {...c} value={form.imapHost} onChange={set("imapHost")} />}
        </Field>
        <Field label={t("pec.imapPort")}>
          {(c) => (
            <Input {...c} inputMode="numeric" value={form.imapPort} onChange={set("imapPort")} />
          )}
        </Field>
        <Field label={t("pec.smtpHost")}>
          {(c) => <Input {...c} value={form.smtpHost} onChange={set("smtpHost")} />}
        </Field>
        <Field label={t("pec.smtpPort")}>
          {(c) => (
            <Input {...c} inputMode="numeric" value={form.smtpPort} onChange={set("smtpPort")} />
          )}
        </Field>
      </div>
      <div className="flex flex-wrap gap-3">
        {preset ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              setForm({
                imapHost: preset.imapHost,
                imapPort: String(preset.imapPort),
                smtpHost: preset.smtpHost,
                smtpPort: String(preset.smtpPort),
              })
            }
          >
            {t("pec.usePreset")}
          </Button>
        ) : null}
        <Button type="submit" disabled={!online || !dirty || save.isPending} className="ms-auto">
          {t("pec.saveServers")}
        </Button>
      </div>
    </form>
  );
}

export function PecSettingsPage() {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const query = useQuery(settingsQuery);
  const features = useQuery({
    queryKey: ["features"],
    queryFn: () => api<Features>("/api/features"),
  });
  const configured = Boolean(features.data?.pec.username && features.data?.pec.password);
  const test = useMutation({
    mutationFn: () => api<PecTestResult>("/api/settings/pec-test", { method: "POST" }),
    onError: () => toast.error(t("settings.pecTestUnavailable")),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["onboarding"] }),
      ]);
    },
  });
  const status = (set: boolean | undefined) =>
    set ? t("settings.configured") : t("settings.notConfigured");

  return (
    <Page title={t("pec.title")} back={SETTINGS_BACK}>
      <div className="max-w-2xl space-y-6">
        {!online ? <Banner tone="warning">{t("offline.reason")}</Banner> : null}
        <section className="space-y-3">
          <h2 className="text-base font-medium">{t("pec.secretsTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("settings.pecIntro")}</p>
          <ul className="space-y-1 text-sm">
            <li>
              {t("settings.pecUsername")}: {status(features.data?.pec.username)}
            </li>
            <li>
              {t("settings.pecPassword")}: {status(features.data?.pec.password)}
            </li>
          </ul>
          <pre className="overflow-x-auto rounded-control bg-muted p-3 text-xs">
            {"wrangler secret put PEC_USERNAME\nwrangler secret put PEC_PASSWORD"}
          </pre>
          <Banner tone="warning">{t("pec.tradeoff")}</Banner>
          {features.data && !configured ? (
            <Banner tone="warning">{t("settings.pecMissing")}</Banner>
          ) : null}
        </section>

        <ServersForm online={online} />

        <section className="space-y-3">
          <h2 className="text-base font-medium">{t("pec.testTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("pec.testScope")}</p>
          {query.data && !test.isPending ? (
            <TestResult result={test.data ?? query.data.pec.test} />
          ) : null}
          <Button
            variant="secondary"
            className="w-fit"
            disabled={!online || !configured || test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? t("settings.pecTesting") : t("settings.pecTest")}
          </Button>
        </section>
      </div>
    </Page>
  );
}
