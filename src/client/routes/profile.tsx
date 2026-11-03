import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../shared/errors";
import { profileInputSchema, REGIME_FISCALE_CODES } from "../../shared/profile";
import { Page } from "../components/page";
import { Banner } from "../components/ui/banner";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { useOnline } from "../lib/online";
import {
  fieldErrors,
  fieldErrorsFromDetail,
  type ProfileResponse,
  profileQuery,
  putJson,
} from "../lib/settings-api";

interface FormState {
  name: string;
  vatNumber: string;
  taxCode: string;
  address: string;
  postalCode: string;
  city: string;
  province: string;
  country: string;
  regimeFiscale: string;
  iban: string;
  bic: string;
  accountHolder: string;
  bankName: string;
  termsDays: string;
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
  regimeFiscale: "RF01",
  iban: "",
  bic: "",
  accountHolder: "",
  bankName: "",
  termsDays: "",
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
    regimeFiscale: p.regimeFiscale,
    iban: p.paymentDefaults.iban ?? "",
    bic: p.paymentDefaults.bic ?? "",
    accountHolder: p.paymentDefaults.accountHolder ?? "",
    bankName: p.paymentDefaults.bankName ?? "",
    termsDays: p.defaultPaymentTermsDays === null ? "" : String(p.defaultPaymentTermsDays),
  };
}

function toBody(f: FormState) {
  const days = f.termsDays.trim();
  return {
    name: f.name,
    vatNumber: f.vatNumber,
    taxCode: f.taxCode,
    address: f.address,
    postalCode: f.postalCode,
    city: f.city,
    province: f.province,
    country: f.country,
    regimeFiscale: f.regimeFiscale,
    paymentDefaults: {
      iban: f.iban,
      bic: f.bic,
      accountHolder: f.accountHolder,
      bankName: f.bankName,
    },
    defaultPaymentTermsDays: days === "" ? null : Number(days),
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
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (query.data && !loaded) {
      if (query.data.profile) setForm(fromProfile(query.data.profile));
      setLoaded(true);
    }
  }, [query.data, loaded]);

  const save = useMutation({
    mutationFn: (body: unknown) => putJson("/api/profile", body),
    onSuccess: async () => {
      setSaved(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["profile"] }),
        queryClient.invalidateQueries({ queryKey: ["onboarding"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "bad_request") {
        setErrors(fieldErrorsFromDetail(error.problem.detail));
      }
    },
  });

  const set = (key: keyof FormState) => (event: { target: { value: string } }) => {
    setSaved(false);
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
      setSaved(false);
      return;
    }
    setErrors({});
    save.mutate(body);
  }

  const serverFailure = save.error && !Object.keys(errors).length;

  return (
    <Page title={t("profile.title")} backToSettings>
      <p className="text-sm text-muted-foreground">{t("profile.intro")}</p>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
      {query.isError ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {saved ? <Banner tone="success">{t("profile.saved")}</Banner> : null}
      {serverFailure ? <Banner tone="danger">{t("common.error")}</Banner> : null}
      {!online ? <Banner tone="warning">{t("offline.reason")}</Banner> : null}
      {query.data ? (
        <form onSubmit={onSubmit} noValidate className="flex max-w-2xl flex-col gap-6">
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 text-base font-medium">{t("profile.issuer")}</legend>
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
            <Field label={t("profile.regime")} error={err("regimeFiscale")}>
              {(c) => (
                <Select {...c} value={form.regimeFiscale} onChange={set("regimeFiscale")}>
                  {REGIME_FISCALE_CODES.map((code) => (
                    <option key={code} value={code}>
                      {code} - {t(`profile.regimes.${code}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </fieldset>

          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 text-base font-medium">{t("profile.addressTitle")}</legend>
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
          </fieldset>

          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 text-base font-medium">{t("profile.paymentTitle")}</legend>
            <Field label={t("profile.iban")} error={err("paymentDefaults.iban")}>
              {(c) => (
                <Input
                  {...c}
                  value={form.iban}
                  onChange={set("iban")}
                  autoCapitalize="characters"
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("profile.bic")} error={err("paymentDefaults.bic")}>
                {(c) => (
                  <Input
                    {...c}
                    value={form.bic}
                    onChange={set("bic")}
                    autoCapitalize="characters"
                  />
                )}
              </Field>
              <Field label={t("profile.bankName")} error={err("paymentDefaults.bankName")}>
                {(c) => <Input {...c} value={form.bankName} onChange={set("bankName")} />}
              </Field>
            </div>
            <Field label={t("profile.accountHolder")} error={err("paymentDefaults.accountHolder")}>
              {(c) => <Input {...c} value={form.accountHolder} onChange={set("accountHolder")} />}
            </Field>
            <Field
              label={t("profile.termsDays")}
              hint={t("profile.termsDaysHint")}
              error={err("defaultPaymentTermsDays")}
            >
              {(c) => (
                <Input
                  {...c}
                  value={form.termsDays}
                  onChange={set("termsDays")}
                  inputMode="numeric"
                />
              )}
            </Field>
          </fieldset>

          <Button type="submit" disabled={!online || save.isPending} className="w-fit">
            {t("profile.save")}
          </Button>
        </form>
      ) : null}
    </Page>
  );
}
