import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../shared/errors";
import { profileInputSchema } from "../../shared/profile";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { GroupBox } from "../components/ui/group-box";
import { Input } from "../components/ui/input";
import { toast } from "../components/ui/toast";
import { SETTINGS_BACK } from "../lib/back-links";
import { useOnline } from "../lib/online";
import {
  fieldErrors,
  fieldErrorsFromDetail,
  type ProfileResponse,
  profileQuery,
  putJson,
} from "../lib/settings-api";
import { useDirty } from "../lib/use-dirty";

interface FormState {
  name: string;
  vatNumber: string;
  taxCode: string;
  address: string;
  postalCode: string;
  city: string;
  province: string;
  country: string;
  email: string;
  phone: string;
}

const EMPTY: FormState = {
  name: "",
  vatNumber: "",
  taxCode: "",
  address: "",
  postalCode: "",
  city: "",
  province: "",
  country: "IT",
  email: "",
  phone: "",
};

function fromProfile(p: ProfileResponse): FormState {
  return {
    name: p.name,
    vatNumber: p.vatNumber,
    taxCode: p.taxCode ?? "",
    address: p.address ?? "",
    postalCode: p.postalCode ?? "",
    city: p.city ?? "",
    province: p.province ?? "",
    country: p.country,
    email: p.email ?? "",
    phone: p.phone ?? "",
  };
}

function toBody(f: FormState) {
  return {
    name: f.name,
    vatNumber: f.vatNumber,
    taxCode: f.taxCode,
    address: f.address,
    postalCode: f.postalCode,
    city: f.city,
    province: f.province,
    country: f.country,
    email: f.email,
    phone: f.phone,
  };
}

export function ProfilePage() {
  const { t } = useTranslation();
  const online = useOnline();
  const queryClient = useQueryClient();
  const query = useQuery(profileQuery);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { dirty, markSaved } = useDirty(EMPTY, form);

  useEffect(() => {
    if (query.data && !loaded) {
      if (query.data.profile) {
        const loadedForm = fromProfile(query.data.profile);
        setForm(loadedForm);
        markSaved(loadedForm);
      }
      setLoaded(true);
    }
  }, [query.data, loaded, markSaved]);

  const save = useMutation({
    mutationFn: (body: unknown) => putJson("/api/profile", body),
    onSuccess: async () => {
      toast.success(t("profile.saved"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["profile"] }),
        queryClient.invalidateQueries({ queryKey: ["onboarding"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["tax"] }),
      ]);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "bad_request") {
        setErrors(fieldErrorsFromDetail(error.problem.detail));
      } else {
        toast.error(t("common.error"));
      }
    },
  });

  const set = (key: keyof FormState) => (event: { target: { value: string } }) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };
  const err = (field: string) => {
    const code = errors[field];
    return code ? t(`validation.${code}`, { defaultValue: t("validation.invalid") }) : undefined;
  };

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = toBody(form);
    const parsed = profileInputSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    save.mutate(body, { onSuccess: () => markSaved(form) });
  }

  return (
    <Page title={t("profile.title")} back={SETTINGS_BACK}>
      <p className="text-sm text-muted-foreground">{t("profile.intro")}</p>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {query.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {!online ? <Banner tone="warning">{t("offline.reason")}</Banner> : null}
      {query.data ? (
        <form onSubmit={onSubmit} noValidate className="flex max-w-2xl flex-col gap-6">
          <fieldset className="flex flex-col gap-4">
            <Field label={t("profile.name")} hint={t("profile.nameHint")} error={err("name")}>
              {(c) => (
                <Input
                  {...c}
                  value={form.name}
                  onChange={set("name")}
                  autoComplete="organization"
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("profile.vatNumber")} error={err("vatNumber")}>
                {(c) => (
                  <Input
                    {...c}
                    value={form.vatNumber}
                    onChange={set("vatNumber")}
                    inputMode="numeric"
                  />
                )}
              </Field>
              <Field
                label={t("profile.taxCode")}
                hint={t("profile.taxCodeHint")}
                error={err("taxCode")}
              >
                {(c) => (
                  <Input
                    {...c}
                    value={form.taxCode}
                    onChange={set("taxCode")}
                    autoCapitalize="characters"
                  />
                )}
              </Field>
            </div>
          </fieldset>

          <GroupBox title={t("profile.addressTitle")}>
            <Field label={t("profile.address")} error={err("address")}>
              {(c) => (
                <Input
                  {...c}
                  value={form.address}
                  onChange={set("address")}
                  autoComplete="street-address"
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t("profile.postalCode")} error={err("postalCode")}>
                {(c) => (
                  <Input
                    {...c}
                    value={form.postalCode}
                    onChange={set("postalCode")}
                    inputMode="numeric"
                    autoComplete="postal-code"
                  />
                )}
              </Field>
              <Field label={t("profile.city")} error={err("city")} className="sm:col-span-2">
                {(c) => (
                  <Input
                    {...c}
                    value={form.city}
                    onChange={set("city")}
                    autoComplete="address-level2"
                  />
                )}
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("profile.province")} error={err("province")}>
                {(c) => (
                  <Input
                    {...c}
                    value={form.province}
                    onChange={set("province")}
                    maxLength={2}
                    autoCapitalize="characters"
                  />
                )}
              </Field>
              <Field label={t("profile.country")} error={err("country")}>
                {(c) => (
                  <Input
                    {...c}
                    value={form.country}
                    onChange={set("country")}
                    maxLength={2}
                    autoCapitalize="characters"
                  />
                )}
              </Field>
            </div>
          </GroupBox>

          <GroupBox title={t("profile.contactsTitle")}>
            <p className="text-sm text-muted-foreground">{t("profile.contactsHint")}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("profile.email")} error={err("email")}>
                {(c) => (
                  <Input
                    {...c}
                    type="email"
                    value={form.email}
                    onChange={set("email")}
                    autoComplete="email"
                  />
                )}
              </Field>
              <Field label={t("profile.phone")} error={err("phone")}>
                {(c) => (
                  <Input
                    {...c}
                    type="tel"
                    value={form.phone}
                    onChange={set("phone")}
                    autoComplete="tel"
                  />
                )}
              </Field>
            </div>
          </GroupBox>

          <div className="flex justify-end">
            <Button type="submit" disabled={!online || !dirty || save.isPending}>
              {t("profile.save")}
            </Button>
          </div>
        </form>
      ) : null}
    </Page>
  );
}
