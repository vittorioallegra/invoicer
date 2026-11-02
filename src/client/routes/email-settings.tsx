import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../shared/errors";
import { COURTESY_EMAIL_MODES, emailSettingsInputSchema } from "../../shared/profile";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { useOnline } from "../lib/online";
import { fieldErrors, fieldErrorsFromDetail, putJson, settingsQuery } from "../lib/settings-api";

export function EmailSettingsPage() {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const query = useQuery(settingsQuery);
  const [form, setForm] = useState({
    senderName: "",
    senderAddress: "",
    replyTo: "",
    bcc: "",
    mode: "ask",
  });
  const [loaded, setLoaded] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (query.data && !loaded) {
      const e = query.data.email;
      setForm({
        senderName: e.senderName ?? "",
        senderAddress: e.senderAddress ?? "",
        replyTo: e.replyTo ?? "",
        bcc: e.bcc ?? "",
        mode: e.mode,
      });
      setLoaded(true);
    }
  }, [query.data, loaded]);

  const save = useMutation({
    mutationFn: (body: unknown) => putJson("/api/settings/email", body),
    onSuccess: async () => {
      setSaved(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["onboarding"] }),
      ]);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "bad_request") {
        setErrors(fieldErrorsFromDetail(error.problem.detail));
      }
    },
  });

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => {
    setSaved(false);
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };
  const err = (field: string) => {
    const code = errors[field];
    return code ? t(`validation.${code}`, { defaultValue: t("validation.invalid") }) : undefined;
  };

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = emailSettingsInputSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      setSaved(false);
      return;
    }
    setErrors({});
    save.mutate(form);
  }

  const defaultName = query.data?.email.defaultSenderName ?? undefined;

  return (
    <Page title={t("email.title")}>
      <p className="text-sm text-muted-foreground">{t("email.intro")}</p>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {query.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {saved ? <Banner tone="success">{t("email.saved")}</Banner> : null}
      {save.error && !Object.keys(errors).length ? (
        <Banner tone="danger">{t("common.error")}</Banner>
      ) : null}
      {!online ? <Banner tone="warning">{t("offline.reason")}</Banner> : null}
      {query.data ? (
        <form onSubmit={onSubmit} noValidate className="flex max-w-2xl flex-col gap-4">
          <Field
            label={t("email.senderName")}
            hint={t("email.senderNameHint")}
            error={err("senderName")}
          >
            {(c) => (
              <Input
                {...c}
                value={form.senderName}
                onChange={set("senderName")}
                {...(defaultName ? { placeholder: defaultName } : {})}
              />
            )}
          </Field>
          <Field
            label={t("email.senderAddress")}
            hint={t("email.senderAddressHint")}
            error={err("senderAddress")}
          >
            {(c) => (
              <Input
                {...c}
                type="email"
                value={form.senderAddress}
                onChange={set("senderAddress")}
              />
            )}
          </Field>
          <Field label={t("email.replyTo")} hint={t("email.replyToHint")} error={err("replyTo")}>
            {(c) => <Input {...c} type="email" value={form.replyTo} onChange={set("replyTo")} />}
          </Field>
          <Field label={t("email.bcc")} hint={t("email.bccHint")} error={err("bcc")}>
            {(c) => <Input {...c} type="email" value={form.bcc} onChange={set("bcc")} />}
          </Field>
          <Field label={t("email.mode")} hint={t("email.modeHint")} error={err("mode")}>
            {(c) => (
              <Select {...c} value={form.mode} onChange={set("mode")}>
                {COURTESY_EMAIL_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`email.modes.${mode}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" disabled={!online || save.isPending} className="w-fit">
            {t("email.save")}
          </Button>
        </form>
      ) : null}
    </Page>
  );
}
